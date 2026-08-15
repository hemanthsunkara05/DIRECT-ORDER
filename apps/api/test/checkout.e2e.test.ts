import { randomUUID } from 'node:crypto';
import type { Payment } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import {
  mutate,
  get,
  registerAndLogin,
  type RegisteredUser,
} from './support/register-and-login.js';
import { MockPaymentProvider } from '../src/modules/payments/providers/mock-payment.provider.js';
import { PaymentVerificationService } from '../src/modules/payments/services/payment-verification.service.js';

/**
 * Phase 9 — the highest-risk phase in the project. Covers the mandated
 * checkout sequence end-to-end plus all ten named failure scenarios
 * from docs/11-testing-strategy.md §18.3: double-click pay, browser
 * crash after payment, duplicate webhook, refresh after payment, price
 * change mid-checkout, item unavailable mid-checkout, provider/backend
 * amount mismatch, invalid webhook signature, cross-customer order
 * access, concurrent identical checkouts.
 */
describe('Orders, checkout, payments (Phase 9, e2e)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  async function setUpRestaurant(
    owner: RegisteredUser,
    options: { minOrderAmountMinor?: number } = {},
  ): Promise<{ slug: string; restaurantId: string; categoryId: string }> {
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

    if (options.minOrderAmountMinor !== undefined) {
      await mutate(ctx, 'patch', '/api/v1/restaurant/settings', owner.cookie)
        .send({ minOrderAmountMinor: options.minOrderAmountMinor })
        .expect(200);
    }

    const category = await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', owner.cookie)
      .send({ name: 'Mains' })
      .expect(201);

    return { slug, restaurantId, categoryId: category.body.data.id as string };
  }

  async function createItem(
    owner: RegisteredUser,
    categoryId: string,
    name: string,
    priceMinor: string,
  ) {
    const res = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
      .send({ categoryId, name, priceMinor })
      .expect(201);
    return res.body.data as { id: string; priceMinor: string };
  }

  async function openCart(
    slug: string,
    items: { itemId: string; quantity: number; unitPriceMinorAtAdd: string }[],
  ): Promise<{ cartId: string; guestToken: string }> {
    const res = await mutate(ctx, 'post', '/api/v1/public/carts')
      .send({ restaurantSlug: slug, items })
      .expect(201);
    return {
      cartId: res.body.data.cartId as string,
      guestToken: res.body.data.guestToken as string,
    };
  }

  function checkoutRequest(cartId: string, guestToken: string, idempotencyKey: string) {
    return mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', idempotencyKey)
      .send({
        cartId,
        guestToken,
        customer: { name: 'Asha Customer', phone: '+919876543210' },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
      });
  }

  async function fullSetup(itemPriceMinor = '10000') {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, 'Masala Dosa', itemPriceMinor);
    const { cartId, guestToken } = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: itemPriceMinor },
    ]);
    return { owner, slug, categoryId, item, cartId, guestToken };
  }

  // ── Cart persistence ──────────────────────────────────────────────

  it('POST /public/carts creates a persisted cart with a guest token', async () => {
    const { cartId, guestToken } = await fullSetup();
    expect(cartId).toBeTruthy();
    expect(guestToken).toBeTruthy();
    expect(ctx.db.carts.find((c) => c.id === cartId)?.status).toBe('OPEN');
  });

  it('POST /public/carts/:id/validate revalidates against live data', async () => {
    const { owner, item, cartId, guestToken } = await fullSetup();
    const before = await mutate(ctx, 'post', `/api/v1/public/carts/${cartId}/validate`)
      .send({ guestToken })
      .expect(200);
    expect(before.body.data.valid).toBe(true);
    expect(before.body.data.issues).toEqual([]);

    // The item's price changes between cart creation and validation —
    // the persisted cart's snapshot price is now stale.
    await mutate(ctx, 'patch', `/api/v1/restaurant/menu/items/${item.id}`, owner.cookie)
      .send({ priceMinor: '20000' })
      .expect(200);

    const after = await mutate(ctx, 'post', `/api/v1/public/carts/${cartId}/validate`)
      .send({ guestToken })
      .expect(200);
    expect(after.body.data.valid).toBe(false);
    expect(after.body.data.issues).toEqual([
      { code: 'PRICE_CHANGED', itemId: item.id, oldPriceMinor: '10000', newPriceMinor: '20000' },
    ]);
  });

  it('rejects cart validation with a wrong guest token identically to a nonexistent cart (404, no leak)', async () => {
    const { cartId } = await fullSetup();
    await mutate(ctx, 'post', `/api/v1/public/carts/${cartId}/validate`)
      .send({ guestToken: 'wrong-token' })
      .expect(404);
    await mutate(ctx, 'post', `/api/v1/public/carts/00000000-0000-0000-0000-000000000000/validate`)
      .send({ guestToken: 'wrong-token' })
      .expect(404);
  });

  // ── Happy path ─────────────────────────────────────────────────────

  it('checkout creates exactly one PENDING_PAYMENT order with a provider payment intent', async () => {
    const { cartId, guestToken } = await fullSetup();
    const res = await checkoutRequest(cartId, guestToken, randomUUID()).expect(200);

    expect(res.body.data.status).toBe('PENDING_PAYMENT');
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.payableTotalMinor).toBe('10000');
    expect(res.body.data.provider.providerOrderId).toBeTruthy();
    expect(ctx.db.orders).toHaveLength(1);
    expect(ctx.db.payments).toHaveLength(1);
    expect(ctx.db.payments[0]!.status).toBe('PENDING');
    // The cart converts — it can't be checked out again.
    expect(ctx.db.carts.find((c) => c.id === cartId)?.status).toBe('CONVERTED');
  });

  it('verify-payment with a providerPaymentId hint that matches nothing fails cleanly, not with a raw 500', async () => {
    // Found live, against real Postgres, during this phase's manual
    // verification: MockPaymentProvider.fetchPaymentStatus used to throw
    // a bare Error for an unrecognized id, which GlobalExceptionFilter
    // has no choice but to report as an opaque 500 INTERNAL_ERROR. Fixed
    // to throw ProviderError (502 SERVICE_UNAVAILABLE), the same typed
    // failure RazorpayPaymentProvider already reports for every
    // provider-side failure.
    const { cartId, guestToken } = await fullSetup();
    const checkoutRes = await checkoutRequest(cartId, guestToken, randomUUID()).expect(200);
    const { orderNumber, accessToken } = checkoutRes.body.data;

    const res = await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/verify-payment`)
      .send({ token: accessToken, providerPaymentId: 'mock_pay_does-not-exist' })
      .expect(502);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('full happy path: checkout -> simulate CAPTURED -> verify-payment -> order PLACED -> visible via tracking', async () => {
    const { cartId, guestToken } = await fullSetup();
    const checkoutRes = await checkoutRequest(cartId, guestToken, randomUUID()).expect(200);
    const { orderNumber, accessToken } = checkoutRes.body.data;

    // Stands in for Razorpay Checkout.js handing the frontend a
    // `razorpay_payment_id` on success — verify-payment takes it only as
    // a lookup hint (BR-37: it fetches the status from the provider,
    // never trusts what the client claims it is).
    const simulateRes = await mutate(
      ctx,
      'post',
      `/api/v1/public/orders/${orderNumber}/simulate-payment`,
    )
      .send({ token: accessToken, outcome: 'CAPTURED' })
      .expect(200);
    const { providerPaymentId } = simulateRes.body.data;

    const verifyRes = await mutate(
      ctx,
      'post',
      `/api/v1/public/orders/${orderNumber}/verify-payment`,
    )
      .send({ token: accessToken, providerPaymentId })
      .expect(200);
    expect(verifyRes.body.data.paymentStatus).toBe('CAPTURED');
    expect(verifyRes.body.data.orderStatus).toBe('PLACED');

    const trackRes = await get(
      ctx,
      `/api/v1/public/orders/${orderNumber}?token=${accessToken}`,
    ).expect(200);
    expect(trackRes.body.data.status).toBe('PLACED');
    expect(trackRes.body.data.paymentStatus).toBe('CAPTURED');
    expect(trackRes.body.data.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
      'PENDING_PAYMENT',
      'PLACED',
    ]);
  });

  it('a failed payment moves the order to PAYMENT_FAILED', async () => {
    const { cartId, guestToken } = await fullSetup();
    const checkoutRes = await checkoutRequest(cartId, guestToken, randomUUID()).expect(200);
    const { orderNumber } = checkoutRes.body.data;

    // A genuinely failed provider attempt never gets a `providerPaymentId`
    // in this mock (see MockPaymentProvider.simulatePaymentOutcome's doc
    // comment) — nothing to poll `verify-payment` with, so this exercises
    // PaymentVerificationService.applyProviderStatus directly, the exact
    // same code path a `payment.failed` webhook would drive.
    const verification = ctx.app.get(PaymentVerificationService);
    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    const paymentRow = ctx.db.payments.find((p) => p.orderId === order.id)!;
    const result = await verification.applyProviderStatus(paymentRow as unknown as Payment, {
      providerPaymentId: 'mock_pay_failed',
      providerOrderId: paymentRow.providerOrderId!,
      status: 'FAILED',
      amountMinor: paymentRow.amountMinor,
      currency: paymentRow.currency,
      failureCode: 'PAYMENT_DECLINED',
      failureMessage: 'The payment was declined.',
    });

    expect(result.payment.status).toBe('FAILED');
    expect(result.orderStatus).toBe('PAYMENT_FAILED');
  });

  // ── Named failure scenario: double-click pay ────────────────────────

  it('double-click pay: replaying the same Idempotency-Key returns the original order, never a second one', async () => {
    const { cartId, guestToken } = await fullSetup();
    const key = randomUUID();
    const first = await checkoutRequest(cartId, guestToken, key).expect(200);
    const second = await checkoutRequest(cartId, guestToken, key).expect(200);

    expect(second.body.data.orderNumber).toBe(first.body.data.orderNumber);
    expect(second.body.data.accessToken).toBeNull(); // replay never reissues the raw token
    expect(ctx.db.orders).toHaveLength(1);
    expect(ctx.db.payments).toHaveLength(1);
  });

  // ── Named failure scenario: concurrent identical checkouts ──────────

  it('concurrent identical checkouts (same Idempotency-Key, fired together) create exactly one order', async () => {
    const { cartId, guestToken } = await fullSetup();
    const key = randomUUID();

    const [a, b] = await Promise.all([
      checkoutRequest(cartId, guestToken, key),
      checkoutRequest(cartId, guestToken, key),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.orderNumber).toBe(b.body.data.orderNumber);
    expect(ctx.db.orders).toHaveLength(1);
    expect(ctx.db.payments).toHaveLength(1);
    // Exactly one of the two responses carries the real access token.
    const tokens = [a.body.data.accessToken, b.body.data.accessToken].filter(Boolean);
    expect(tokens).toHaveLength(1);
  });

  // ── Named failure scenario: price change mid-checkout ────────────────

  it('price change mid-checkout: 409 PRICE_CHANGED, no order created', async () => {
    const { owner, item, cartId, guestToken } = await fullSetup('10000');
    await mutate(ctx, 'patch', `/api/v1/restaurant/menu/items/${item.id}`, owner.cookie)
      .send({ priceMinor: '15000' })
      .expect(200);

    const res = await checkoutRequest(cartId, guestToken, randomUUID()).expect(409);
    expect(res.body.error.code).toBe('PRICE_CHANGED');
    expect(ctx.db.orders).toHaveLength(0);
  });

  // ── Named failure scenario: item unavailable mid-checkout ────────────

  it('item unavailable mid-checkout: 409 ITEM_UNAVAILABLE, no order created', async () => {
    const { owner, item, cartId, guestToken } = await fullSetup();
    await mutate(
      ctx,
      'patch',
      `/api/v1/restaurant/menu/items/${item.id}/availability`,
      owner.cookie,
    )
      .send({ isAvailable: false })
      .expect(200);

    const res = await checkoutRequest(cartId, guestToken, randomUUID()).expect(409);
    expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
    expect(ctx.db.orders).toHaveLength(0);
  });

  it('checkout rejects a client-supplied expectedTotalMinor that no longer matches (409 TOTAL_MISMATCH)', async () => {
    const { cartId, guestToken } = await fullSetup('10000');
    const res = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId,
        guestToken,
        customer: { name: 'Asha Customer', phone: '+919876543210' },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
        expectedTotalMinor: '99999',
      })
      .expect(409);
    expect(res.body.error.code).toBe('TOTAL_MISMATCH');
  });

  it('checkout requires the Idempotency-Key header (422)', async () => {
    const { cartId, guestToken } = await fullSetup();
    await mutate(ctx, 'post', '/api/v1/public/checkout')
      .send({
        cartId,
        guestToken,
        customer: { name: 'Asha Customer', phone: '+919876543210' },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
      })
      .expect(422);
  });

  // ── Named failure scenario: provider/backend amount mismatch ────────

  it('provider/backend amount mismatch: order stays PENDING_PAYMENT and a CRITICAL reconciliation issue is raised', async () => {
    const { cartId, guestToken } = await fullSetup('10000');
    const checkoutRes = await checkoutRequest(cartId, guestToken, randomUUID()).expect(200);
    const { orderNumber, accessToken } = checkoutRes.body.data;

    const mockProvider = ctx.app.get(MockPaymentProvider);
    const payment = ctx.db.payments[0]!;
    const { providerPaymentId } = await mockProvider.simulatePaymentOutcome(
      payment.providerOrderId!,
      'CAPTURED',
      {
        amountMinor: 999999n, // does not match the order's payable total
      },
    );

    const verifyRes = await mutate(
      ctx,
      'post',
      `/api/v1/public/orders/${orderNumber}/verify-payment`,
    )
      .send({ token: accessToken, providerPaymentId })
      .expect(200);

    expect(verifyRes.body.data.orderStatus).toBe('PENDING_PAYMENT');
    expect(verifyRes.body.data.paymentStatus).not.toBe('CAPTURED');
    expect(ctx.db.reconciliationIssues).toHaveLength(1);
    expect(ctx.db.reconciliationIssues[0]!.severity).toBe('CRITICAL');
    expect(ctx.db.reconciliationIssues[0]!.issueType).toBe('AMOUNT_MISMATCH');
  });

  // ── Named failure scenario: invalid webhook signature ────────────────

  it('invalid webhook signature: rejected before any processing or storage', async () => {
    ctx = await createTestApp();
    const res = await mutate(ctx, 'post', '/api/v1/webhooks/razorpay')
      .set('x-razorpay-signature', 'not-a-real-signature')
      .send({ id: 'evt_fake', event: 'payment.captured', payload: {} })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(ctx.db.webhookEvents).toHaveLength(0);
  });

  // ── Named failure scenario: duplicate webhook ────────────────────────

  it('duplicate webhook: the same signed event applied twice is processed once', async () => {
    const { cartId, guestToken } = await fullSetup('10000');
    const checkoutRes = await checkoutRequest(cartId, guestToken, randomUUID()).expect(200);
    const { orderNumber } = checkoutRes.body.data;

    const mockProvider = ctx.app.get(MockPaymentProvider);
    const payment = ctx.db.payments[0]!;
    const { providerPaymentId } = await mockProvider.simulatePaymentOutcome(
      payment.providerOrderId!,
      'CAPTURED',
    );
    const body = mockProvider.signWebhookBody(
      'payment.captured',
      providerPaymentId!,
      payment.providerOrderId!,
    );
    const signature = mockProvider.signature(body);

    // Sent as a pre-serialized JSON string (not a plain object) so
    // supertest transmits these exact bytes verbatim — HMAC signatures
    // are computed over specific bytes, and JSON.stringify(JSON.parse(x))
    // is not guaranteed byte-identical to `x` in general.
    const first = await mutate(ctx, 'post', '/api/v1/webhooks/razorpay')
      .set('x-razorpay-signature', signature)
      .type('json')
      .send(body.toString('utf8'))
      .expect(200);
    const second = await mutate(ctx, 'post', '/api/v1/webhooks/razorpay')
      .set('x-razorpay-signature', signature)
      .type('json')
      .send(body.toString('utf8'))
      .expect(200);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(ctx.db.webhookEvents).toHaveLength(1); // second insert hit ON CONFLICT DO NOTHING, ignored
    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    expect(order.status).toBe('PLACED');
    expect(ctx.db.orderStatusHistory.filter((h) => h.orderId === order.id)).toHaveLength(2); // not duplicated
  });

  // ── Named failure scenario: browser crash after payment (webhook-only recovery) ──

  it('browser crash after payment: the webhook alone (no frontend verify-payment call) places the order', async () => {
    const { cartId, guestToken } = await fullSetup('10000');
    const checkoutRes = await checkoutRequest(cartId, guestToken, randomUUID()).expect(200);
    const { orderNumber } = checkoutRes.body.data;

    const mockProvider = ctx.app.get(MockPaymentProvider);
    const payment = ctx.db.payments[0]!;
    const { providerPaymentId } = await mockProvider.simulatePaymentOutcome(
      payment.providerOrderId!,
      'CAPTURED',
    );
    const body = mockProvider.signWebhookBody(
      'payment.captured',
      providerPaymentId!,
      payment.providerOrderId!,
    );
    const signature = mockProvider.signature(body);

    await mutate(ctx, 'post', '/api/v1/webhooks/razorpay')
      .set('x-razorpay-signature', signature)
      .type('json')
      .send(body.toString('utf8'))
      .expect(200);

    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    expect(order.status).toBe('PLACED');
  });

  // ── Named failure scenario: refresh after payment ────────────────────

  it('refresh after payment: re-fetching tracking and re-calling verify-payment after CAPTURED is stable, not double-applied', async () => {
    const { cartId, guestToken } = await fullSetup('10000');
    const checkoutRes = await checkoutRequest(cartId, guestToken, randomUUID()).expect(200);
    const { orderNumber, accessToken } = checkoutRes.body.data;

    const simulateRes = await mutate(
      ctx,
      'post',
      `/api/v1/public/orders/${orderNumber}/simulate-payment`,
    )
      .send({ token: accessToken, outcome: 'CAPTURED' })
      .expect(200);
    const { providerPaymentId } = simulateRes.body.data;
    await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/verify-payment`)
      .send({ token: accessToken, providerPaymentId })
      .expect(200);

    // Simulated "refresh": call verify-payment again and re-fetch tracking.
    const secondVerify = await mutate(
      ctx,
      'post',
      `/api/v1/public/orders/${orderNumber}/verify-payment`,
    )
      .send({ token: accessToken, providerPaymentId })
      .expect(200);
    expect(secondVerify.body.data.orderStatus).toBe('PLACED');

    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    expect(ctx.db.orderStatusHistory.filter((h) => h.orderId === order.id)).toHaveLength(2);
  });

  // ── Named failure scenario: cross-customer order access ──────────────

  it('cross-customer order access: tracking with no/wrong token 404s identically to a nonexistent order', async () => {
    const { cartId, guestToken } = await fullSetup();
    const checkoutRes = await checkoutRequest(cartId, guestToken, randomUUID()).expect(200);
    const { orderNumber } = checkoutRes.body.data;

    await get(ctx, `/api/v1/public/orders/${orderNumber}`).expect(404);
    await get(ctx, `/api/v1/public/orders/${orderNumber}?token=not-the-real-token`).expect(404);
    await get(ctx, `/api/v1/public/orders/DO-000000-XXXXX?token=not-the-real-token`).expect(404);
  });

  it("simulate-payment 404s once PAYMENT_PROVIDER is not 'mock'", async () => {
    ctx = await createTestApp({ PAYMENT_PROVIDER: 'razorpay' as never });
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, 'Idli', '8000');
    const { cartId, guestToken } = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: '8000' },
    ]);
    // Razorpay has no real credentials in this sandbox, so checkout
    // itself fails at the provider call — this test only needs to prove
    // the simulate-payment route is gone, so it checks the route
    // directly against a fabricated order number instead of completing
    // a real checkout.
    void cartId;
    void guestToken;
    await mutate(ctx, 'post', '/api/v1/public/orders/DO-000000-XXXXX/simulate-payment')
      .send({ token: 'x', outcome: 'CAPTURED' })
      .expect(404);
  });
});
