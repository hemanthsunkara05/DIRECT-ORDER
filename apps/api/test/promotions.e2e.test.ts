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
import { OutboxService } from '../src/platform/outbox/outbox.service.js';
import { PaymentVerificationService } from '../src/modules/payments/services/payment-verification.service.js';

/**
 * Phase 14 — the full promotions suite from docs/14-acceptance-criteria.md:
 * concurrent-claim safety on a limit-N coupon, per-customer limits,
 * reservation release on payment failure, anti-enumeration, discount
 * caps/floors, and restaurant-vs-platform promotion isolation.
 */
describe('Promotions (Phase 14, e2e)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  async function setUpRestaurant(
    owner: RegisteredUser,
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

    const category = await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', owner.cookie)
      .send({ name: 'Mains' })
      .expect(201);

    return { slug, restaurantId, categoryId: category.body.data.id as string };
  }

  async function createItem(owner: RegisteredUser, categoryId: string, priceMinor: string) {
    const res = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
      .send({ categoryId, name: 'Masala Dosa', priceMinor })
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

  function checkoutRequest(
    cartId: string,
    guestToken: string,
    idempotencyKey: string,
    options: { couponCode?: string; phone?: string } = {},
  ) {
    return mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', idempotencyKey)
      .send({
        cartId,
        guestToken,
        customer: { name: 'Asha Customer', phone: options.phone ?? '+919876543210' },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
        ...(options.couponCode ? { couponCode: options.couponCode } : {}),
      });
  }

  /** Full setup: owner + ACTIVE restaurant + one ₹100 item. Returns everything needed to open fresh carts against it. */
  async function fullSetup(itemPriceMinor = '10000') {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, restaurantId, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, itemPriceMinor);
    return { owner, slug, restaurantId, categoryId, item };
  }

  async function createCoupon(
    owner: RegisteredUser,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; code: string }> {
    const res = await mutate(ctx, 'post', '/api/v1/restaurant/promotions', owner.cookie)
      .send({
        code: `SAVE${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        name: 'Test promo',
        type: 'PERCENTAGE',
        value: 10,
        ...overrides,
      })
      .expect(201);
    return { id: res.body.data.id as string, code: res.body.data.code as string };
  }

  // ── BR-87: row-locked usage limits ──────────────────────────────────

  it('a coupon with usage_limit_total = 1 under 10 concurrent claims yields exactly 1 redemption', async () => {
    const { owner, slug, item } = await fullSetup();
    const coupon = await createCoupon(owner, { usageLimitTotal: 1 });

    const attempts = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const { cartId, guestToken } = await openCart(slug, [
          { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
        ]);
        return checkoutRequest(cartId, guestToken, randomUUID(), {
          couponCode: coupon.code,
          phone: `+9198765432${String(i).padStart(2, '0')}`,
        });
      }),
    );

    const succeeded = attempts.filter((r) => r.status === 200);
    const exhausted = attempts.filter(
      (r) => r.status === 409 && r.body.error.code === 'COUPON_EXHAUSTED',
    );
    expect(succeeded).toHaveLength(1);
    expect(exhausted).toHaveLength(9);

    const redemptions = ctx.db.promotionRedemptions.filter((r) => r.promotionId === coupon.id);
    expect(redemptions).toHaveLength(1);
  });

  it('a per-customer limit of 1 cannot be exceeded by the same customer', async () => {
    const { owner, slug, item } = await fullSetup();
    const coupon = await createCoupon(owner, { usageLimitPerCustomer: 1 });
    const phone = '+919876500001';

    const first = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    await checkoutRequest(first.cartId, first.guestToken, randomUUID(), {
      couponCode: coupon.code,
      phone,
    }).expect(200);

    const second = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const res = await checkoutRequest(second.cartId, second.guestToken, randomUUID(), {
      couponCode: coupon.code,
      phone,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('COUPON_EXHAUSTED');

    // A DIFFERENT customer is unaffected by the first customer's usage.
    const third = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    await checkoutRequest(third.cartId, third.guestToken, randomUUID(), {
      couponCode: coupon.code,
      phone: '+919876500002',
    }).expect(200);
  });

  // ── BR-89: reservation released on payment failure ──────────────────

  it('a failed payment releases the reservation, and the coupon becomes usable again', async () => {
    const { owner, slug, item } = await fullSetup();
    const coupon = await createCoupon(owner, { usageLimitTotal: 1 });

    const first = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const checkoutRes = await checkoutRequest(first.cartId, first.guestToken, randomUUID(), {
      couponCode: coupon.code,
    }).expect(200);
    const { orderNumber } = checkoutRes.body.data;

    const redemption = ctx.db.promotionRedemptions.find((r) => r.promotionId === coupon.id)!;
    expect(redemption.status).toBe('RESERVED');

    // Fail the payment — the same code path a `payment.failed` webhook drives.
    const verification = ctx.app.get(PaymentVerificationService);
    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    const paymentRow = ctx.db.payments.find((p) => p.orderId === order.id)!;
    await verification.applyProviderStatus(paymentRow as unknown as Payment, {
      providerPaymentId: 'mock_pay_failed',
      providerOrderId: paymentRow.providerOrderId!,
      status: 'FAILED',
      amountMinor: paymentRow.amountMinor,
      currency: paymentRow.currency,
      failureCode: 'PAYMENT_DECLINED',
      failureMessage: 'The payment was declined.',
    });

    // Drive the outbox relay — the real, un-mocked consumer, not a test-only shortcut.
    await ctx.app.get(OutboxService).relayPending();

    expect(redemption.status).toBe('RELEASED');

    // The coupon is usable again — a second checkout by a different customer succeeds.
    const second = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    await checkoutRequest(second.cartId, second.guestToken, randomUUID(), {
      couponCode: coupon.code,
      phone: '+919876500099',
    }).expect(200);
  });

  it('a real order PLACED (payment captured) confirms the reservation, and a later cancellation does not release it (BR-90)', async () => {
    const { owner, slug, item } = await fullSetup();
    const coupon = await createCoupon(owner, { usageLimitTotal: 1 });

    const { cartId, guestToken } = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const checkoutRes = await checkoutRequest(cartId, guestToken, randomUUID(), {
      couponCode: coupon.code,
    }).expect(200);
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

    await ctx.app.get(OutboxService).relayPending();

    const redemption = ctx.db.promotionRedemptions.find((r) => r.promotionId === coupon.id)!;
    expect(redemption.status).toBe('CONFIRMED');

    // BR-90: cancellation after payment does NOT return coupon usage — the redemption stays CONFIRMED.
    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    order.status = 'CANCELLED';
    order.cancelledAt = new Date();
    expect(redemption.status).toBe('CONFIRMED');
  });

  // ── BR-95: anti-enumeration ──────────────────────────────────────────

  it('an unknown coupon code and an expired one are both rejected with the identical generic error', async () => {
    const { owner, slug, item } = await fullSetup();
    const expired = await createCoupon(owner, {
      endsAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const cartA = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const resUnknown = await checkoutRequest(cartA.cartId, cartA.guestToken, randomUUID(), {
      couponCode: 'DOES-NOT-EXIST',
    });

    const cartB = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const resExpired = await checkoutRequest(cartB.cartId, cartB.guestToken, randomUUID(), {
      couponCode: expired.code,
      phone: '+919876500055',
    });

    expect(resUnknown.status).toBe(409);
    expect(resExpired.status).toBe(409);
    expect(resUnknown.body.error.code).toBe('COUPON_INVALID');
    expect(resExpired.body.error.code).toBe('COUPON_INVALID');
    expect(resUnknown.body.error.message).toBe(resExpired.body.error.message);
  });

  // ── BR-91/BR-92: discount shape ───────────────────────────────────────

  it('a percentage discount respects its configured maximum cap', async () => {
    // 50% of ₹1000 = ₹500, but capped at ₹50.
    const { owner, slug, item } = await fullSetup('100000');
    const coupon = await createCoupon(owner, {
      type: 'PERCENTAGE',
      value: 50,
      maxDiscountMinor: '5000',
    });

    const { cartId, guestToken } = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const res = await checkoutRequest(cartId, guestToken, randomUUID(), {
      couponCode: coupon.code,
    }).expect(200);
    expect(res.body.data.breakdown.promotionDiscountMinor).toBe('5000');
  });

  it('a fixed discount never drives the payable total below zero', async () => {
    const { owner, slug, item } = await fullSetup('1000'); // ₹10 item
    const coupon = await createCoupon(owner, { type: 'FIXED_AMOUNT', value: 100000 }); // ₹1000 off

    const { cartId, guestToken } = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const res = await checkoutRequest(cartId, guestToken, randomUUID(), {
      couponCode: coupon.code,
    }).expect(200);
    expect(Number(res.body.data.payableTotalMinor)).toBeGreaterThanOrEqual(0);
    expect(res.body.data.breakdown.payableTotalMinor).toBe('0');
  });

  // ── Restaurant vs. platform isolation ────────────────────────────────

  it('a restaurant cannot create or modify platform-wide promotions', async () => {
    const { owner } = await fullSetup();

    // Attempting to set restaurantId: null via the restaurant endpoint
    // is silently ignored — the created promotion still belongs to the
    // caller's own tenant, never platform-wide.
    const created = await mutate(ctx, 'post', '/api/v1/restaurant/promotions', owner.cookie)
      .send({
        restaurantId: null,
        code: 'SNEAKY10',
        name: 'Sneaky',
        type: 'PERCENTAGE',
        value: 10,
      })
      .expect(201);
    expect(created.body.data.restaurantId).not.toBeNull();

    // A genuinely platform-wide promotion (seeded directly, as only an
    // admin's endpoint could create) cannot be modified by a restaurant —
    // 404, not 403, matching this codebase's tenant-isolation convention.
    ctx.db.promotions.push({
      id: randomUUID(),
      restaurantId: null,
      code: 'PLATFORMWIDE',
      name: 'Platform promo',
      type: 'PERCENTAGE',
      value: 5,
      minOrderMinor: null,
      maxDiscountMinor: null,
      startsAt: null,
      endsAt: null,
      usageLimitTotal: null,
      usageLimitPerCustomer: null,
      firstOrderOnly: false,
      isActive: true,
      createdByUserId: randomUUID(),
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const platformPromo = ctx.db.promotions.find((p) => p.code === 'PLATFORMWIDE')!;

    await mutate(ctx, 'patch', `/api/v1/restaurant/promotions/${platformPromo.id}`, owner.cookie)
      .send({ isActive: false })
      .expect(404);
    expect(platformPromo.isActive).toBe(true);
  });

  // ── Discount values sent by the client are ignored entirely ─────────

  it('discount values sent by the client are ignored entirely — the server computes the total', async () => {
    const { owner, slug, item } = await fullSetup('10000');
    const coupon = await createCoupon(owner, { type: 'PERCENTAGE', value: 10 });

    const { cartId, guestToken } = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const res = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId,
        guestToken,
        customer: { name: 'Asha Customer', phone: '+919876543299' },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
        couponCode: coupon.code,
        // Not a real field on CheckoutDto — stripped by zod, and even if
        // it were read, the total below proves it was never trusted.
        discountMinor: '999999',
        expectedTotalMinor: '1',
      })
      .expect(409); // expectedTotalMinor mismatch proves the server, not the client, computed the real total
    expect(res.body.error.code).toBe('TOTAL_MISMATCH');
  });

  // ── Admin platform promotions ─────────────────────────────────────────

  it('FREE_DELIVERY caps the discount at the real delivery fee, never Promotion.value', async () => {
    const { owner, slug, item } = await fullSetup('10000');
    await mutate(ctx, 'patch', '/api/v1/restaurant/settings', owner.cookie)
      .send({ deliveryFeeMode: 'FLAT', deliveryFeeFlatMinor: '3000' })
      .expect(200);
    // value is deliberately huge and advisory-only — must never be read.
    const coupon = await createCoupon(owner, { type: 'FREE_DELIVERY', value: 999999 });

    const { cartId, guestToken } = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const res = await checkoutRequest(cartId, guestToken, randomUUID(), {
      couponCode: coupon.code,
    }).expect(200);
    expect(res.body.data.breakdown.deliveryFeeMinor).toBe('3000');
    expect(res.body.data.breakdown.promotionDiscountMinor).toBe('3000');
  });

  it('first_order_only rejects a customer with a prior DELIVERED order, and admits a genuine first-timer', async () => {
    const { owner, slug, item } = await fullSetup('10000');
    const coupon = await createCoupon(owner, { firstOrderOnly: true });
    const repeatPhone = '+919876500077';

    // Give repeatPhone a prior DELIVERED order at this restaurant, without a coupon.
    const priorCart = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const priorRes = await checkoutRequest(priorCart.cartId, priorCart.guestToken, randomUUID(), {
      phone: repeatPhone,
    }).expect(200);
    const priorOrder = ctx.db.orders.find((o) => o.orderNumber === priorRes.body.data.orderNumber)!;
    priorOrder.status = 'DELIVERED';

    const repeatCart = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const repeatRes = await checkoutRequest(
      repeatCart.cartId,
      repeatCart.guestToken,
      randomUUID(),
      {
        couponCode: coupon.code,
        phone: repeatPhone,
      },
    );
    expect(repeatRes.status).toBe(409);
    expect(repeatRes.body.error.code).toBe('COUPON_INVALID');

    const firstTimerCart = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    await checkoutRequest(firstTimerCart.cartId, firstTimerCart.guestToken, randomUUID(), {
      couponCode: coupon.code,
      phone: '+919876500088',
    }).expect(200);
  });

  it("/restaurant/promotions only lists the caller's own promotions, not another restaurant's", async () => {
    const { owner } = await fullSetup();
    await createCoupon(owner, { code: 'MINE10' });

    const otherOwner = await registerAndLogin(ctx);
    await setUpRestaurant(otherOwner);
    await createCoupon(otherOwner, { code: 'THEIRS10' });

    const listRes = await get(ctx, '/api/v1/restaurant/promotions', owner.cookie).expect(200);
    const codes = (listRes.body.data as { code: string }[]).map((p) => p.code);
    expect(codes).toEqual(['MINE10']);
  });

  it('an admin can create a platform-wide promotion usable by any restaurant', async () => {
    const { slug, item } = await fullSetup('10000');

    // Seed a SUPER_ADMIN the same way admin.e2e.test.ts does — directly,
    // since no HTTP path creates the first admin (Phase 13's own,
    // deliberate scope boundary).
    const admin = await registerAndLogin(ctx, { email: 'super@direct-order.test' });
    ctx.db.adminUsers.push({
      id: randomUUID(),
      userId: admin.userId,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const session = ctx.db.sessions.find((s) => s.userId === admin.userId)!;
    session.mfaVerifiedAt = new Date();
    // AuthorizationGuard's admin branch also requires User.mfaEnabledAt
    // (enrollment), not just the session's per-session verification.
    const user = ctx.db.users.find((u) => u.id === admin.userId)!;
    user.mfaEnabledAt = new Date();

    const created = await mutate(ctx, 'post', '/api/v1/admin/promotions', admin.cookie)
      .send({ code: 'PLATFORM20', name: 'Platform-wide', type: 'PERCENTAGE', value: 20 })
      .expect(201);
    expect(created.body.data.restaurantId).toBeNull();

    const { cartId, guestToken } = await openCart(slug, [
      { itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor },
    ]);
    const checkoutRes = await checkoutRequest(cartId, guestToken, randomUUID(), {
      couponCode: 'PLATFORM20',
    }).expect(200);
    expect(checkoutRes.body.data.breakdown.promotionDiscountMinor).toBe('2000');
  });

  it('GET /public/checkout/quote previews a valid coupon without reserving it', async () => {
    const { owner, slug, item } = await fullSetup('10000');
    const coupon = await createCoupon(owner, { type: 'PERCENTAGE', value: 10, usageLimitTotal: 5 });

    const res = await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor }],
        couponCode: coupon.code,
      })
      .expect(200);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.breakdown.promotionDiscountMinor).toBe('1000');
    // A preview never reserves — no redemption row exists yet.
    expect(ctx.db.promotionRedemptions).toHaveLength(0);
  });
});
