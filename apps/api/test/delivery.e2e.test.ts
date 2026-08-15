import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { get, mutate, registerAndLogin } from './support/register-and-login.js';
import { MockPaymentProvider } from '../src/modules/payments/providers/mock-payment.provider.js';
import { PaymentVerificationService } from '../src/modules/payments/services/payment-verification.service.js';
import { MockDeliveryProvider } from '../src/modules/delivery/providers/mock-delivery.provider.js';
import { DeliveryDispatchService } from '../src/modules/delivery/services/delivery-dispatch.service.js';
import { OrderRepository } from '../src/modules/orders/repositories/order.repository.js';

/**
 * Phase 11 — delivery integration. Every scenario named in
 * docs/14-acceptance-criteria.md is covered here: exactly-one-dispatch
 * (both the HTTP-idempotent-replay path and the true DB-constraint
 * concurrency path), timeout-not-treated-as-failure, provider rejection
 * never marking an order out for delivery, duplicate-webhook dedup,
 * DELIVERED arriving before PICKED_UP, and customer tracking reflecting
 * real delivery state.
 */
describe('Delivery integration (Phase 11, e2e)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  async function setUpRestaurantWithPreparingOrder(itemPriceMinor = '20000') {
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Spice Route' })
      .expect(201);
    const restaurantId = created.body.data.id as string;
    const slug = created.body.data.slug as string;
    const row = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    row.status = 'ACTIVE';
    row.orderingEnabled = true;
    await mutate(ctx, 'put', '/api/v1/restaurant/hours', owner.cookie)
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '00:00',
          closesAt: '23:59',
        })),
      })
      .expect(200);
    // A pickup address is required for dispatch — DeliveryDispatchService
    // reads it from the restaurant's own profile, same address a real
    // courier would be sent to.
    await mutate(ctx, 'patch', '/api/v1/restaurant/profile', owner.cookie)
      .send({
        address: {
          line1: '123 MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        },
      })
      .expect(200);
    const category = await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', owner.cookie)
      .send({ name: 'Mains' })
      .expect(201);
    const item = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
      .send({ categoryId: category.body.data.id, name: 'Thali', priceMinor: itemPriceMinor })
      .expect(201);

    const cartRes = await mutate(ctx, 'post', '/api/v1/public/carts')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.body.data.id, quantity: 1, unitPriceMinorAtAdd: itemPriceMinor }],
      })
      .expect(201);
    const checkoutRes = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId: cartRes.body.data.cartId,
        guestToken: cartRes.body.data.guestToken,
        customer: { name: 'Asha Customer', phone: '+919876543210' },
        deliveryAddress: {
          line1: 'Flat 4B, Palm Residency',
          city: 'Bengaluru',
          postalCode: '560034',
        },
      })
      .expect(200);

    const mockPayment = ctx.app.get(MockPaymentProvider);
    const payment = ctx.db.payments.at(-1)!;
    const { providerPaymentId } = await mockPayment.simulatePaymentOutcome(
      payment.providerOrderId!,
      'CAPTURED',
    );
    const verification = ctx.app.get(PaymentVerificationService);
    await verification.verify(checkoutRes.body.data.orderNumber, providerPaymentId!);

    const order = ctx.db.orders.find((o) => o.orderNumber === checkoutRes.body.data.orderNumber)!;
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/preparing`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);

    return {
      owner,
      restaurantId,
      order,
      orderNumber: checkoutRes.body.data.orderNumber as string,
      accessToken: checkoutRes.body.data.accessToken as string,
    };
  }

  function markReady(owner: { cookie: string }, orderId: string) {
    return mutate(ctx, 'post', `/api/v1/restaurant/orders/${orderId}/ready`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({});
  }

  async function readyWithDelivery(itemPriceMinor = '20000') {
    const setup = await setUpRestaurantWithPreparingOrder(itemPriceMinor);
    await markReady(setup.owner, setup.order.id).expect(200);
    const delivery = ctx.db.deliveries.find((d) => d.orderId === setup.order.id)!;
    return { ...setup, delivery };
  }

  it('marking ready dispatches exactly one delivery', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPreparingOrder();

    await markReady(owner, order.id).expect(200);

    expect(ctx.db.deliveries).toHaveLength(1);
    const delivery = ctx.db.deliveries[0]!;
    expect(delivery.orderId).toBe(order.id);
    expect(delivery.provider).toBe('mock_delivery');
    expect(delivery.status).toBe('CREATED');
    expect(delivery.providerDeliveryId).toBeTruthy();
  });

  it('DELIVERY_PROVIDER=mock: the restaurant delivery view reports the mock provider, never claiming production delivery', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPreparingOrder();
    await markReady(owner, order.id).expect(200);

    const detail = await get(ctx, `/api/v1/restaurant/orders/${order.id}`, owner.cookie).expect(
      200,
    );
    expect(detail.body.data.delivery.provider).toBe('mock_delivery');
  });

  it('marking ready twice (HTTP replay) results in exactly one delivery row', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPreparingOrder();

    const first = await markReady(owner, order.id).expect(200);
    const second = await markReady(owner, order.id).expect(200);

    expect(first.body.data.applied).toBe(true);
    expect(second.body.data.applied).toBe(false);
    expect(ctx.db.deliveries).toHaveLength(1);
  });

  it('concurrent dispatch attempts for the same order create exactly one delivery row', async () => {
    ctx = await createTestApp();
    const { order } = await setUpRestaurantWithPreparingOrder();
    const dispatch = ctx.app.get(DeliveryDispatchService);
    const orders = ctx.app.get(OrderRepository);
    const orderRow = (await orders.findById(order.id))!;

    await Promise.all([dispatch.dispatch(orderRow), dispatch.dispatch(orderRow)]);

    expect(ctx.db.deliveries).toHaveLength(1);
  });

  it('a provider timeout leaves the delivery ambiguous (not a definite failure) and a retry never creates a second row', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPreparingOrder();
    const mockDelivery = ctx.app.get(MockDeliveryProvider);
    mockDelivery.forceOutcome(order.id, 'TIMEOUT');

    await markReady(owner, order.id).expect(200);

    expect(ctx.db.deliveries).toHaveLength(1);
    const delivery = ctx.db.deliveries[0]!;
    expect(delivery.status).toBe('PENDING_CREATION'); // ambiguous, never assumed failed
    expect(delivery.providerDeliveryId).toBeNull();
    expect(delivery.failureReason).toContain('timed out');

    // "a retry" — dispatch() called again (what a future redispatch would
    // do) must not create a second row for this order.
    const orders = ctx.app.get(OrderRepository);
    const orderRow = (await orders.findById(order.id))!;
    const dispatch = ctx.app.get(DeliveryDispatchService);
    await dispatch.dispatch(orderRow);

    expect(ctx.db.deliveries).toHaveLength(1);
  });

  it('provider rejection leaves the order at READY_FOR_PICKUP (never marked out for delivery) and alerts via the outbox', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPreparingOrder();
    const mockDelivery = ctx.app.get(MockDeliveryProvider);
    mockDelivery.forceOutcome(order.id, 'REJECT');

    const res = await markReady(owner, order.id).expect(200);
    expect(res.body.data.status).toBe('READY_FOR_PICKUP');

    const orderRow = ctx.db.orders.find((o) => o.id === order.id)!;
    expect(orderRow.status).toBe('READY_FOR_PICKUP'); // never OUT_FOR_DELIVERY

    const delivery = ctx.db.deliveries.find((d) => d.orderId === order.id)!;
    expect(delivery.status).toBe('CREATION_FAILED');
    expect(delivery.failureReason).toBeTruthy();

    const alerts = ctx.db.outboxEvents.filter((e) => e.eventType === 'DELIVERY_CREATION_FAILED');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.restaurantId).toBe(order.restaurantId);
  });

  it('a duplicate delivery webhook produces exactly one order transition', async () => {
    ctx = await createTestApp();
    const { order, delivery } = await readyWithDelivery();
    const mockDelivery = ctx.app.get(MockDeliveryProvider);
    mockDelivery.advanceStatus(delivery.providerDeliveryId!, 'COURIER_ASSIGNED', {
      courierName: 'Ravi Kumar',
      courierPhone: '+919812345678',
    });
    const body = mockDelivery.signWebhookBody('delivery.updated', delivery.providerDeliveryId!);
    const signature = mockDelivery.signature(body);

    // Sent as a pre-serialized JSON string, not a plain object — same
    // reasoning as the Razorpay webhook tests: HMAC is computed over
    // specific bytes, and supertest must transmit them verbatim.
    const first = await mutate(ctx, 'post', '/api/v1/webhooks/delivery/mock_delivery')
      .set('x-delivery-signature', signature)
      .type('json')
      .send(body.toString('utf8'))
      .expect(200);
    const second = await mutate(ctx, 'post', '/api/v1/webhooks/delivery/mock_delivery')
      .set('x-delivery-signature', signature)
      .type('json')
      .send(body.toString('utf8'))
      .expect(200);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(ctx.db.webhookEvents.filter((w) => w.provider === 'mock_delivery')).toHaveLength(1);
    const orderRow = ctx.db.orders.find((o) => o.id === order.id)!;
    expect(orderRow.status).toBe('OUT_FOR_DELIVERY');
    expect(
      ctx.db.orderStatusHistory.filter(
        (h) => h.orderId === order.id && h.toStatus === 'OUT_FOR_DELIVERY',
      ),
    ).toHaveLength(1);
  });

  it('an unsigned/invalid delivery webhook is rejected before any processing or storage', async () => {
    ctx = await createTestApp();
    const res = await mutate(ctx, 'post', '/api/v1/webhooks/delivery/mock_delivery')
      .set('x-delivery-signature', 'not-a-real-signature')
      .send({ id: 'evt_fake', event: 'delivery.updated', delivery_id: 'mock_delivery_fake' })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(ctx.db.webhookEvents).toHaveLength(0);
  });

  it('a webhook naming a provider other than the active one 404s', async () => {
    ctx = await createTestApp();
    await mutate(ctx, 'post', '/api/v1/webhooks/delivery/uber_direct')
      .set('x-delivery-signature', 'irrelevant')
      .send({})
      .expect(404);
  });

  it('DELIVERED arriving before PICKED_UP is applied directly, without error or state corruption', async () => {
    ctx = await createTestApp();
    const { order, delivery } = await readyWithDelivery();
    const mockDelivery = ctx.app.get(MockDeliveryProvider);
    // Skips SEARCHING_COURIER / COURIER_ASSIGNED / PICKED_UP entirely —
    // the out-of-order case named in docs/03-state-machines.md §7.4.
    mockDelivery.advanceStatus(delivery.providerDeliveryId!, 'DELIVERED');
    const body = mockDelivery.signWebhookBody('delivery.updated', delivery.providerDeliveryId!);
    const signature = mockDelivery.signature(body);

    await mutate(ctx, 'post', '/api/v1/webhooks/delivery/mock_delivery')
      .set('x-delivery-signature', signature)
      .type('json')
      .send(body.toString('utf8'))
      .expect(200);

    const orderRow = ctx.db.orders.find((o) => o.id === order.id)!;
    expect(orderRow.status).toBe('DELIVERED');
    const deliveryRow = ctx.db.deliveries.find((d) => d.id === delivery.id)!;
    expect(deliveryRow.status).toBe('DELIVERED');
    // Both hops recorded — the order never silently skipped OUT_FOR_DELIVERY.
    expect(
      ctx.db.orderStatusHistory
        .filter((h) => h.orderId === order.id)
        .map((h) => h.toStatus)
        .slice(-2),
    ).toEqual(['OUT_FOR_DELIVERY', 'DELIVERED']);
  });

  it('a regression (e.g. a stale event reporting an earlier stage after DELIVERED) is ignored, not applied', async () => {
    ctx = await createTestApp();
    const { order, delivery } = await readyWithDelivery();
    const mockDelivery = ctx.app.get(MockDeliveryProvider);
    mockDelivery.advanceStatus(delivery.providerDeliveryId!, 'DELIVERED');
    const deliveredBody = mockDelivery.signWebhookBody(
      'delivery.updated',
      delivery.providerDeliveryId!,
    );
    await mutate(ctx, 'post', '/api/v1/webhooks/delivery/mock_delivery')
      .set('x-delivery-signature', mockDelivery.signature(deliveredBody))
      .type('json')
      .send(deliveredBody.toString('utf8'))
      .expect(200);

    // A stray/late event reporting an earlier stage arrives after DELIVERED.
    mockDelivery.advanceStatus(delivery.providerDeliveryId!, 'PICKED_UP');
    const staleBody = mockDelivery.signWebhookBody(
      'delivery.updated',
      delivery.providerDeliveryId!,
    );
    await mutate(ctx, 'post', '/api/v1/webhooks/delivery/mock_delivery')
      .set('x-delivery-signature', mockDelivery.signature(staleBody))
      .type('json')
      .send(staleBody.toString('utf8'))
      .expect(200);

    const deliveryRow = ctx.db.deliveries.find((d) => d.id === delivery.id)!;
    expect(deliveryRow.status).toBe('DELIVERED'); // unchanged — terminal, no regression
    const orderRow = ctx.db.orders.find((o) => o.id === order.id)!;
    expect(orderRow.status).toBe('DELIVERED');
  });

  it('customer tracking reflects real delivery state (courier, status) once dispatched', async () => {
    ctx = await createTestApp();
    const { order, delivery, orderNumber, accessToken } = await readyWithDelivery();
    const mockDelivery = ctx.app.get(MockDeliveryProvider);
    mockDelivery.advanceStatus(delivery.providerDeliveryId!, 'COURIER_ASSIGNED', {
      courierName: 'Ravi Kumar',
      courierPhone: '+919812345678',
    });
    const body = mockDelivery.signWebhookBody('delivery.updated', delivery.providerDeliveryId!);
    await mutate(ctx, 'post', '/api/v1/webhooks/delivery/mock_delivery')
      .set('x-delivery-signature', mockDelivery.signature(body))
      .type('json')
      .send(body.toString('utf8'))
      .expect(200);

    const res = await get(ctx, `/api/v1/public/orders/${orderNumber}?token=${accessToken}`).expect(
      200,
    );

    expect(res.body.data.status).toBe('OUT_FOR_DELIVERY');
    expect(res.body.data.delivery.status).toBe('COURIER_ASSIGNED');
    expect(res.body.data.delivery.courierName).toBe('Ravi Kumar');
    // Customer-safe subset only — no provider identity/ids/fees leaked.
    expect(res.body.data.delivery).not.toHaveProperty('provider');
    expect(res.body.data.delivery).not.toHaveProperty('providerDeliveryId');
    expect(res.body.data.delivery).not.toHaveProperty('quotedFeeMinor');
    void order;
  });

  it('a different restaurant cannot read this order or its delivery info (404, not the resource)', async () => {
    ctx = await createTestApp();
    const { order, delivery } = await readyWithDelivery();
    const { owner: otherOwner } = await setUpRestaurantWithPreparingOrder();
    void delivery;

    await get(ctx, `/api/v1/restaurant/orders/${order.id}`, otherOwner.cookie).expect(404);
  });
});
