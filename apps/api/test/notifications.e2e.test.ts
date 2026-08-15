import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboxEvent } from '@prisma/client';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { get, mutate, registerAndLogin } from './support/register-and-login.js';
import { MockPaymentProvider } from '../src/modules/payments/providers/mock-payment.provider.js';
import { PaymentVerificationService } from '../src/modules/payments/services/payment-verification.service.js';
import { MockDeliveryProvider } from '../src/modules/delivery/providers/mock-delivery.provider.js';
import { OutboxService } from '../src/platform/outbox/outbox.service.js';
import { NotificationDispatchService } from '../src/modules/notifications/services/notification-dispatch.service.js';
import { NotificationPreferenceService } from '../src/modules/notifications/services/notification-preference.service.js';
import { ConsoleSmsProvider } from '../src/modules/notifications/channels/console-sms.provider.js';

/**
 * Phase 12 — notifications. docs/14-acceptance-criteria.md's named
 * scenarios, adapted for one standing scope decision (documented in
 * PHASE_REPORTS.md): `/me/notifications*` only serves the
 * RESTAURANT_USER recipient type this phase — guest checkout is still
 * the pilot default (AMB-2), so there is no registered customer session
 * to authenticate a customer-facing notification centre against yet.
 * "Customer A cannot read Customer B's notifications" is therefore
 * proven below as "restaurant staff A cannot read restaurant staff B's
 * notifications" — the identical `recipient_type`/`recipient_id`-match
 * rule (docs/05-authorization-matrix.md), applied to the recipient type
 * that actually has an authenticated session today.
 */
describe('Notifications (Phase 12, e2e)', () => {
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
    return { owner, restaurantId, order, orderNumber: checkoutRes.body.data.orderNumber as string };
  }

  it('each order state change generates the specified notifications (docs/08 §14.4)', async () => {
    ctx = await createTestApp();
    const { owner, order } = await setUpRestaurantWithPlacedOrder();
    const outbox = ctx.app.get(OutboxService);

    await outbox.relayPending();
    const customerPlaced = ctx.db.notifications.filter(
      (n) => n.recipientType === 'CUSTOMER' && n.type === 'ORDER_PLACED_CUSTOMER',
    );
    expect(customerPlaced.map((n) => n.channel).sort()).toEqual(['IN_APP', 'SMS']); // one row per channel, per docs/08 §14.4's ORDER_PLACED_CUSTOMER row
    const restaurantPlaced = ctx.db.notifications.filter(
      (n) => n.recipientType === 'RESTAURANT_USER' && n.type === 'ORDER_PLACED_RESTAURANT',
    );
    expect(restaurantPlaced.map((n) => n.channel).sort()).toEqual(['IN_APP', 'SMS', 'WHATSAPP']);

    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    await outbox.relayPending();
    expect(ctx.db.notifications.some((n) => n.type === 'ORDER_ACCEPTED')).toBe(true);

    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/preparing`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    await outbox.relayPending();
    const preparing = ctx.db.notifications.filter((n) => n.type === 'ORDER_PREPARING');
    expect(preparing.map((n) => n.channel)).toEqual(['IN_APP']); // no SMS for PREPARING, per the catalogue

    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/ready`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    await outbox.relayPending();
    expect(ctx.db.notifications.some((n) => n.type === 'ORDER_READY')).toBe(true);

    // Delivery dispatch (Phase 11) already ran as part of `ready()` — advance
    // the mock provider and simulate its webhook to exercise the
    // delivery-driven notifications (DELIVERY_ASSIGNED, DELIVERY_OUT, ORDER_DELIVERED).
    const delivery = ctx.db.deliveries.find((d) => d.orderId === order.id)!;
    const mockDelivery = ctx.app.get(MockDeliveryProvider);
    mockDelivery.advanceStatus(delivery.providerDeliveryId!, 'COURIER_ASSIGNED', {
      courierName: 'Ravi Kumar',
    });
    let body = mockDelivery.signWebhookBody('delivery.updated', delivery.providerDeliveryId!);
    await mutate(ctx, 'post', '/api/v1/webhooks/delivery/mock_delivery')
      .set('x-delivery-signature', mockDelivery.signature(body))
      .type('json')
      .send(body.toString('utf8'))
      .expect(200);
    await outbox.relayPending();
    expect(ctx.db.notifications.some((n) => n.type === 'DELIVERY_ASSIGNED')).toBe(true);
    expect(ctx.db.notifications.some((n) => n.type === 'DELIVERY_OUT')).toBe(true); // ORDER_OUT_FOR_DELIVERY fired by the same webhook

    mockDelivery.advanceStatus(delivery.providerDeliveryId!, 'DELIVERED');
    body = mockDelivery.signWebhookBody('delivery.updated', delivery.providerDeliveryId!);
    await mutate(ctx, 'post', '/api/v1/webhooks/delivery/mock_delivery')
      .set('x-delivery-signature', mockDelivery.signature(body))
      .type('json')
      .send(body.toString('utf8'))
      .expect(200);
    await outbox.relayPending();
    expect(ctx.db.notifications.some((n) => n.type === 'ORDER_DELIVERED')).toBe(true);
  });

  it('a duplicated domain event produces one notification per recipient per channel', async () => {
    ctx = await createTestApp();
    await setUpRestaurantWithPlacedOrder();
    const outbox = ctx.app.get(OutboxService);
    const dispatch = ctx.app.get(NotificationDispatchService);

    await outbox.relayPending(); // first, normal relay
    const placedEvent = ctx.db.outboxEvents.find((e) => e.eventType === 'ORDER_PLACED')!;
    const before = ctx.db.notifications.filter((n) => n.outboxEventId === placedEvent.id).length;
    expect(before).toBeGreaterThan(0);

    // Simulate a duplicate delivery of the SAME event (e.g. an
    // at-least-once redelivery) by handing it to the dispatch pipeline
    // directly a second time — bypassing the outbox's own once-per-tick
    // relay, to isolate exactly what docs/14.1 calls "structural"
    // deduplication: the Notification table's own unique constraint.
    await dispatch.handleOutboxEvent(placedEvent as unknown as OutboxEvent);
    const after = ctx.db.notifications.filter((n) => n.outboxEventId === placedEvent.id).length;
    expect(after).toBe(before);
  });

  it('a transactional preference cannot be disabled via the API', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);

    const res = await mutate(ctx, 'patch', '/api/v1/me/notification-preferences', owner.cookie)
      .send({ category: 'TRANSACTIONAL', channel: 'SMS', enabled: false })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');

    // SECURITY is equally non-disableable.
    await mutate(ctx, 'patch', '/api/v1/me/notification-preferences', owner.cookie)
      .send({ category: 'SECURITY', channel: 'SMS', enabled: false })
      .expect(409);

    // A disableable category (ACCOUNT) succeeds, proving the guard is category-specific, not blanket.
    await mutate(ctx, 'patch', '/api/v1/me/notification-preferences', owner.cookie)
      .send({ category: 'ACCOUNT', channel: 'EMAIL', enabled: false })
      .expect(200);
  });

  it(
    'a marketing notification is not sent without recorded consent (BR-129) — the guard, ' +
      'proven directly since no MARKETING event is wired to any producer yet (same "built and ' +
      'unit-tested complete, no real caller yet" treatment RefundService got in Phase 9)',
    async () => {
      ctx = await createTestApp();
      const preferences = ctx.app.get(NotificationPreferenceService);
      const customer = ctx.db.customers[0] ?? {
        id: randomUUID(),
        userId: null,
        fullName: 'Test Customer',
        phone: '+919876543210',
        email: null,
        status: 'ACTIVE' as const,
        marketingConsentAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      if (!ctx.db.customers.includes(customer)) ctx.db.customers.push(customer);

      expect(await preferences.hasMarketingConsent('CUSTOMER', customer.id)).toBe(false);

      customer.marketingConsentAt = new Date();
      expect(await preferences.hasMarketingConsent('CUSTOMER', customer.id)).toBe(true);

      // Account creation is explicitly NOT consent (BR-129) — a fresh
      // customer with no marketingConsentAt is never treated as opted in.
      const freshCustomer = { ...customer, id: randomUUID(), marketingConsentAt: null };
      ctx.db.customers.push(freshCustomer);
      expect(await preferences.hasMarketingConsent('CUSTOMER', freshCustomer.id)).toBe(false);
    },
  );

  it('with the SMS provider failing, the order still completes and the notification retries then dead-letters', async () => {
    ctx = await createTestApp();
    const { order } = await setUpRestaurantWithPlacedOrder();
    const outbox = ctx.app.get(OutboxService);
    const dispatch = ctx.app.get(NotificationDispatchService);
    const smsProvider = ctx.app.get(ConsoleSmsProvider);
    const sendSpy = vi
      .spyOn(smsProvider, 'send')
      .mockRejectedValue(new Error('mock SMS provider 500'));

    await outbox.relayPending();

    // The order itself completed successfully regardless (BR-126) —
    // checked BEFORE and independent of anything below.
    expect(ctx.db.orders.find((o) => o.id === order.id)!.status).toBe('PLACED');

    const smsNotification = ctx.db.notifications.find(
      (n) => n.type === 'ORDER_PLACED_CUSTOMER' && n.channel === 'SMS',
    )!;
    expect(smsNotification.status).toBe('FAILED');
    expect(smsNotification.attempts).toBe(1);
    expect(smsNotification.nextAttemptAt).not.toBeNull();

    // The IN_APP notification for the same event/recipient succeeded —
    // one channel's provider outage never blocks another channel.
    const inAppNotification = ctx.db.notifications.find(
      (n) => n.type === 'ORDER_PLACED_CUSTOMER' && n.channel === 'IN_APP',
    )!;
    expect(inAppNotification.status).toBe('SENT');

    // Drive the retry loop directly (what NotificationRetryScheduler's
    // poller would do on each tick) until it dead-letters.
    for (let i = 0; i < 4; i++) {
      await dispatch.attemptSend(smsNotification.id);
    }
    const final = ctx.db.notifications.find((n) => n.id === smsNotification.id)!;
    expect(final.status).toBe('DEAD_LETTERED');
    expect(final.attempts).toBe(5);
    expect(final.nextAttemptAt).toBeNull();
    expect(final.lastError).toContain('mock SMS provider 500');
    expect(sendSpy).toHaveBeenCalledTimes(5);
  });

  it('unread count is correct after read, read-all, and new notifications', async () => {
    ctx = await createTestApp();
    const { owner } = await setUpRestaurantWithPlacedOrder();
    const outbox = ctx.app.get(OutboxService);
    await outbox.relayPending();

    const afterFirst = await get(ctx, '/api/v1/me/notifications/unread-count', owner.cookie).expect(
      200,
    );
    expect(afterFirst.body.data.count).toBe(1);

    const list = await get(ctx, '/api/v1/me/notifications', owner.cookie).expect(200);
    const notificationId = list.body.data[0].id as string;
    await mutate(ctx, 'post', `/api/v1/me/notifications/${notificationId}/read`, owner.cookie)
      .send({})
      .expect(200);
    const afterRead = await get(ctx, '/api/v1/me/notifications/unread-count', owner.cookie).expect(
      200,
    );
    expect(afterRead.body.data.count).toBe(0);

    // Idempotent — reading an already-read notification again is still 200, not an error.
    await mutate(ctx, 'post', `/api/v1/me/notifications/${notificationId}/read`, owner.cookie)
      .send({})
      .expect(200);

    // A new notification for the same restaurant is counted correctly.
    // Simplest reliable way to produce a second one for the SAME
    // owner/restaurant: record another ORDER_PLACED-shaped outbox event
    // directly and relay it — exercising the same catalogue path a real
    // second order would, without repeating the full checkout flow.
    const restaurantId = ctx.db.restaurantStaff.find(
      (s) => s.userId === owner.userId,
    )!.restaurantId;
    const anotherOrder = ctx.db.orders.find((o) => o.restaurantId === restaurantId)!;
    await outbox.record('ORDER_PLACED', { orderId: anotherOrder.id }, restaurantId);
    await outbox.relayPending();

    const afterNew = await get(ctx, '/api/v1/me/notifications/unread-count', owner.cookie).expect(
      200,
    );
    expect(afterNew.body.data.count).toBe(1);

    const readAllRes = await mutate(ctx, 'post', '/api/v1/me/notifications/read-all', owner.cookie)
      .send({})
      .expect(200);
    expect(readAllRes.body.data.updated).toBe(1);
    const afterReadAll = await get(
      ctx,
      '/api/v1/me/notifications/unread-count',
      owner.cookie,
    ).expect(200);
    expect(afterReadAll.body.data.count).toBe(0);
  });

  it("restaurant staff A cannot read restaurant staff B's notifications (404, not the resource)", async () => {
    ctx = await createTestApp();
    const { owner: ownerA } = await setUpRestaurantWithPlacedOrder();
    const { owner: ownerB } = await setUpRestaurantWithPlacedOrder();
    const outbox = ctx.app.get(OutboxService);
    await outbox.relayPending();

    const listA = await get(ctx, '/api/v1/me/notifications', ownerA.cookie).expect(200);
    const notificationIdFromA = listA.body.data[0].id as string;

    await mutate(ctx, 'post', `/api/v1/me/notifications/${notificationIdFromA}/read`, ownerB.cookie)
      .send({})
      .expect(404);
  });
});
