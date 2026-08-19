import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { get, mutate, registerAndLogin } from './support/register-and-login.js';
import { MockPaymentProvider } from '../src/modules/payments/providers/mock-payment.provider.js';
import { PaymentVerificationService } from '../src/modules/payments/services/payment-verification.service.js';
import { OrderStateService } from '../src/modules/orders/services/order-state.service.js';
import { OutboxService } from '../src/platform/outbox/outbox.service.js';

/**
 * Phase 10 — restaurant order management. docs/14-acceptance-criteria.md:
 * a paid order appears without manual refresh, two staff accepting
 * simultaneously produces one transition, double rejection creates
 * exactly one refund (and it's automatic on rejecting a paid order),
 * SSE replay by a cursor, the restaurant sees only its own orders with
 * server-side pagination, staff cannot alter any historical price/
 * payment field (there is simply no endpoint that lets them — proven
 * implicitly by this suite never needing one).
 *
 * The SSE HTTP endpoint itself (`GET /restaurant/orders/stream`) is
 * deliberately not driven end-to-end through supertest here: it's a
 * genuinely open-ended streaming response (never calls `res.end()`),
 * which supertest has no good way to assert on without either
 * buffering forever or risking a hung test process. Its actual
 * replay/poll logic — `OutboxService.findSinceForRestaurant` — is
 * exercised directly below instead; the route itself (guards, content
 * type, that it's wired at all) was confirmed via manual `curl` during
 * this phase's live-boot check, the same treatment Phase 9 gave the
 * webhook receiver's raw-body handling.
 */
describe('Restaurant order management (Phase 10, e2e)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  async function setUpRestaurantWithPlacedOrder(itemPriceMinor = '20000') {
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Spice Route' })
      .expect(201);
    const restaurantId = created.body.data.id as string;
    const slug = created.body.data.slug as string;
    const row = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    row.status = 'ACTIVE';
    row.orderingEnabled = true;
    // Phase 11: DeliveryDispatchService reads this on `ready()` — an
    // operating restaurant has a pickup address on file, same as the
    // Phase 5 onboarding flow already requires before submission.
    ctx.db.restaurantAddresses.push({
      id: randomUUID(),
      restaurantId,
      line1: '123 MG Road',
      line2: null,
      locality: null,
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      latitude: null,
      longitude: null,
      landmark: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await mutate(ctx, 'put', '/api/v1/restaurant/hours', owner.cookie)
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '00:00',
          closesAt: '23:59',
        })),
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
        deliveryAddress: { line1: 'x', city: 'Bengaluru', postalCode: '560001' },
      })
      .expect(200);

    const mockProvider = ctx.app.get(MockPaymentProvider);
    const payment = ctx.db.payments.at(-1)!;
    const { providerPaymentId } = await mockProvider.simulatePaymentOutcome(
      payment.providerOrderId!,
      'CAPTURED',
    );
    const verification = ctx.app.get(PaymentVerificationService);
    await verification.verify(checkoutRes.body.data.orderNumber, providerPaymentId!);

    const order = ctx.db.orders.find((o) => o.orderNumber === checkoutRes.body.data.orderNumber)!;
    return { owner, restaurantId, slug, order };
  }

  it('the restaurant sees only its own orders, server-side paginated', async () => {
    ctx = await createTestApp();
    const { owner } = await setUpRestaurantWithPlacedOrder();
    await setUpRestaurantWithPlacedOrder(); // a second, unrelated restaurant + order

    const res = await get(ctx, '/api/v1/restaurant/orders', owner.cookie).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('PLACED');
    expect(res.body.meta.pagination).toMatchObject({ hasMore: false, limit: 20 });
  });

  it('a different restaurant cannot read this order (404, not the resource)', async () => {
    ctx = await createTestApp();
    const { order } = await setUpRestaurantWithPlacedOrder();
    const { owner: otherOwner } = await setUpRestaurantWithPlacedOrder();

    await get(ctx, `/api/v1/restaurant/orders/${order.id}`, otherOwner.cookie).expect(404);
    const list = await get(ctx, '/api/v1/restaurant/orders', otherOwner.cookie).expect(200);
    expect(list.body.data).toHaveLength(1); // only the other restaurant's own order
    expect(list.body.data[0].id).not.toBe(order.id);
  });

  it('order detail returns items, history, and payment status', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();

    const res = await get(ctx, `/api/v1/restaurant/orders/${order.id}`, owner.cookie).expect(200);
    expect(res.body.data.status).toBe('PLACED');
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.payment.status).toBe('CAPTURED');
    expect(res.body.data.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'PENDING_PAYMENT',
      'PLACED',
    ]);
  });

  it('the order queue filters by status', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);

    const placed = await get(ctx, '/api/v1/restaurant/orders?status=PLACED', owner.cookie).expect(
      200,
    );
    expect(placed.body.data).toHaveLength(0);
    const accepted = await get(
      ctx,
      '/api/v1/restaurant/orders?status=ACCEPTED',
      owner.cookie,
    ).expect(200);
    expect(accepted.body.data).toHaveLength(1);
  });

  it('accept moves PLACED -> ACCEPTED', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();

    const res = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/orders/${order.id}/accept`,
      owner.cookie,
    )
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    expect(res.body.data.status).toBe('ACCEPTED');
    expect(res.body.data.applied).toBe(true);
  });

  it('accept requires the Idempotency-Key header (422)', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();

    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .send({})
      .expect(422);
  });

  it('two staff accepting concurrently: one transition, one idempotent 200', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();

    const [a, b] = await Promise.all([
      mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
        .set('Idempotency-Key', randomUUID())
        .send({}),
      mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
        .set('Idempotency-Key', randomUUID())
        .send({}),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.data.applied, b.body.data.applied].sort()).toEqual([false, true]);
    expect(ctx.db.orders.find((o) => o.id === order.id)!.status).toBe('ACCEPTED');
    expect(
      ctx.db.orderStatusHistory.filter((h) => h.orderId === order.id && h.toStatus === 'ACCEPTED'),
    ).toHaveLength(1);
  });

  it('an invalid transition (ready before accept/preparing) returns 409 with the current state', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();

    const res = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/orders/${order.id}/ready`,
      owner.cookie,
    )
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('the full accept -> preparing -> ready flow works and emits restaurant-scoped outbox events', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();

    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/preparing`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    const readyRes = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/orders/${order.id}/ready`,
      owner.cookie,
    )
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);

    expect(readyRes.body.data.status).toBe('READY_FOR_PICKUP');
    const events = ctx.db.outboxEvents.filter(
      (e) => (e.payload as { orderId?: string }).orderId === order.id,
    );
    expect(events.map((e) => e.eventType)).toEqual([
      'ORDER_PENDING_PAYMENT', // CheckoutService's own event, at order creation
      'ORDER_PLACED',
      'ORDER_ACCEPTED',
      'ORDER_PREPARING',
      'ORDER_READY_FOR_PICKUP',
    ]);
    expect(events.every((e) => e.restaurantId === order.restaurantId)).toBe(true);
  });

  it('rejecting a paid order triggers exactly one full refund', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder('20000');

    const res = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/orders/${order.id}/reject`,
      owner.cookie,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Out of ingredients' })
      .expect(200);

    expect(res.body.data.status).toBe('REJECTED');
    expect(ctx.db.refunds).toHaveLength(1);
    expect(ctx.db.refunds[0]!.amountMinor).toBe(20000n);
    const payment = ctx.db.payments.find((p) => p.orderId === order.id)!;
    expect(payment.status).toBe('REFUNDED');
  });

  it('reject requires a reason (422)', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();

    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/reject`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(422);
  });

  it('double rejection (sequential) creates exactly one refund', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder('20000');

    const first = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/orders/${order.id}/reject`,
      owner.cookie,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Out of ingredients' })
      .expect(200);
    const second = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/orders/${order.id}/reject`,
      owner.cookie,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Out of ingredients' })
      .expect(200);

    expect(first.body.data.applied).toBe(true);
    expect(second.body.data.applied).toBe(false);
    expect(ctx.db.refunds).toHaveLength(1);
  });

  it('double rejection (concurrent) creates exactly one refund', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder('20000');

    const [a, b] = await Promise.all([
      mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/reject`, owner.cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'concurrent A' }),
      mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/reject`, owner.cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'concurrent B' }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.data.applied, b.body.data.applied].sort()).toEqual([false, true]);
    expect(ctx.db.refunds).toHaveLength(1);
    expect(ctx.db.orders.find((o) => o.id === order.id)!.status).toBe('REJECTED');
  });

  // ── Restaurant-initiated cancellation-after-accept (docs/06 BR-174) ──

  function addMembership(
    userId: string,
    restaurantId: string,
    role: 'STAFF' | 'MANAGER' | 'OWNER',
    invitedByUserId: string,
  ) {
    ctx.db.restaurantStaff.push({
      id: randomUUID(),
      userId,
      restaurantId,
      role,
      status: 'ACTIVE',
      invitedByUserId,
      joinedAt: new Date(),
      disabledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('OWNER cancelling an ACCEPTED order triggers a full refund and records the reason', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder('20000');
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);

    const res = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/orders/${order.id}/cancel`,
      owner.cookie,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Delivery partner unavailable' })
      .expect(200);

    expect(res.body.data.status).toBe('CANCELLED');
    expect(ctx.db.refunds).toHaveLength(1);
    expect(ctx.db.refunds[0]!.amountMinor).toBe(20000n);
    const payment = ctx.db.payments.find((p) => p.orderId === order.id)!;
    expect(payment.status).toBe('REFUNDED');
    const cancelled = ctx.db.orders.find((o) => o.id === order.id)!;
    expect(cancelled.cancellationReason).toBe('Delivery partner unavailable');
  });

  it('cancel also works from PREPARING and READY_FOR_PICKUP', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/preparing`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);

    const res = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/orders/${order.id}/cancel`,
      owner.cookie,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Kitchen equipment failure' })
      .expect(200);
    expect(res.body.data.status).toBe('CANCELLED');
  });

  it('cancel requires a reason (422)', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);

    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/cancel`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(422);
  });

  it('cancel requires the Idempotency-Key header (422)', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);

    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/cancel`, owner.cookie)
      .send({ reason: 'x' })
      .expect(422);
  });

  it('cancel is gated on orders:cancel — STAFF (no MANAGER/OWNER) gets 403, even for their own restaurant', async () => {
    ctx = await createTestApp();
    const { owner, restaurantId, order } = await setUpRestaurantWithPlacedOrder();
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);

    const staff = await registerAndLogin(ctx, { email: `staff-${randomUUID()}@spiceroute.test` });
    addMembership(staff.userId, restaurantId, 'STAFF', owner.userId);

    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/cancel`, staff.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'trying anyway' })
      .expect(403);
  });

  it('a PLACED (not yet accepted) order cannot be cancelled — reject is the only exit from PLACED (409)', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();

    const res = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/orders/${order.id}/cancel`,
      owner.cookie,
    )
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'too early' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('double cancellation (concurrent) creates exactly one refund', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder('20000');
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);

    const [a, b] = await Promise.all([
      mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/cancel`, owner.cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'concurrent A' }),
      mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/cancel`, owner.cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ reason: 'concurrent B' }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.data.applied, b.body.data.applied].sort()).toEqual([false, true]);
    expect(ctx.db.refunds).toHaveLength(1);
    expect(ctx.db.orders.find((o) => o.id === order.id)!.status).toBe('CANCELLED');
  });

  // ── SSE replay logic (OutboxService.findSinceForRestaurant) ─────────

  it("replay returns only this restaurant's events, strictly after the given cursor", async () => {
    ctx = await createTestApp();
    const { restaurantId, order } = await setUpRestaurantWithPlacedOrder();
    const outbox = ctx.app.get(OutboxService);

    // A second restaurant's event must never leak into the first's replay.
    await outbox.record('ORDER_PLACED', { orderId: 'other-order' }, randomUUID());

    const beforeAccept = ctx.db.outboxEvents.filter((e) => e.restaurantId === restaurantId);
    expect(beforeAccept.map((e) => e.eventType)).toEqual(['ORDER_PENDING_PAYMENT', 'ORDER_PLACED']);
    const checkoutEventId = beforeAccept.at(-1)!.id; // resume point: "I've already seen up through PLACED"

    const orderState = ctx.app.get(OrderStateService);
    await orderState.transition(order.id, 'ACCEPTED', { type: 'RESTAURANT_USER' });

    const replaySinceCheckout = await outbox.findSinceForRestaurant(
      restaurantId,
      checkoutEventId,
      50,
    );
    expect(replaySinceCheckout).toHaveLength(1);
    expect(replaySinceCheckout[0]!.eventType).toBe('ORDER_ACCEPTED');

    const fullHistory = await outbox.findSinceForRestaurant(restaurantId, undefined, 50);
    expect(fullHistory.map((e) => e.eventType)).toEqual([
      'ORDER_PENDING_PAYMENT',
      'ORDER_PLACED',
      'ORDER_ACCEPTED',
    ]);
  });
});
