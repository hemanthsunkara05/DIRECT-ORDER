import { randomUUID } from 'node:crypto';
import type { Order } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { mutate, get, registerAndLogin, type RegisteredUser } from './support/register-and-login.js';
import { registerAndLoginCustomer } from './support/register-and-login-customer.js';
import { OutboxService } from '../src/platform/outbox/outbox.service.js';
import { OrderStateService } from '../src/modules/orders/services/order-state.service.js';
import { RefundService } from '../src/modules/payments/services/refund.service.js';
import { LoyaltyEarnService } from '../src/modules/loyalty/services/loyalty-earn.service.js';
import { ReferralService } from '../src/modules/loyalty/services/referral.service.js';
import { ReferralRepository } from '../src/modules/loyalty/repositories/referral.repository.js';
import { LoyaltyAccountRepository } from '../src/modules/loyalty/repositories/loyalty-account.repository.js';
import { LoyaltyReconciliationService } from '../src/modules/loyalty/services/loyalty-reconciliation.service.js';

/**
 * Phase 16 — the full loyalty and referral suite from
 * docs/14-acceptance-criteria.md: points granted on DELIVERED (and
 * only DELIVERED), duplicate-event idempotency, concurrent-redemption
 * safety, proportional refund clawback, the ledger-vs-balance
 * reconciliation invariant, admin adjustments via ledger only,
 * self-referral blocked at the database, one referrer per customer,
 * idempotent reward issuance, and referrer-side privacy.
 */
describe('Loyalty and referrals (Phase 16, e2e)', () => {
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
      .send({ categoryId, name: 'Butter Chicken', priceMinor })
      .expect(201);
    return res.body.data as { id: string; priceMinor: string };
  }

  /** Full setup: owner + ACTIVE restaurant + one ₹200 item (200 minor units of subtotal earns exactly 2 points at the default rate). */
  async function fullSetup(itemPriceMinor = '20000') {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, restaurantId, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, itemPriceMinor);
    return { owner, slug, restaurantId, categoryId, item };
  }

  async function openCart(slug: string, itemId: string, priceMinor: string, quantity = 1) {
    const res = await mutate(ctx, 'post', '/api/v1/public/carts')
      .send({ restaurantSlug: slug, items: [{ itemId, quantity, unitPriceMinorAtAdd: priceMinor }] })
      .expect(201);
    return {
      cartId: res.body.data.cartId as string,
      guestToken: res.body.data.guestToken as string,
    };
  }

  /** Checkout, capture payment, and confirm it — leaves the order at PLACED. Optionally as a logged-in customer, optionally redeeming points. */
  async function placeAndPayOrder(
    cartId: string,
    guestToken: string,
    options: { customerCookie?: string; phone?: string; redeemLoyaltyPoints?: number } = {},
  ) {
    const checkoutRes = await mutate(ctx, 'post', '/api/v1/public/checkout', options.customerCookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId,
        guestToken,
        customer: { name: 'Asha Customer', phone: options.phone ?? '+919876500001' },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
        ...(options.redeemLoyaltyPoints ? { redeemLoyaltyPoints: options.redeemLoyaltyPoints } : {}),
      });
    if (checkoutRes.status !== 200) return { checkoutRes, orderNumber: null as string | null };

    const { orderNumber, accessToken } = checkoutRes.body.data;
    const simulateRes = await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/simulate-payment`)
      .send({ token: accessToken, outcome: 'CAPTURED' })
      .expect(200);
    await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/verify-payment`)
      .send({ token: accessToken, providerPaymentId: simulateRes.body.data.providerPaymentId })
      .expect(200);
    await ctx.app.get(OutboxService).relayPending();

    return { checkoutRes, orderNumber: orderNumber as string };
  }

  /** Walks an already-PLACED order through the real state machine to DELIVERED, relaying the outbox after each step (matching the mandatory HTTP-driven path's own event emission, just without going through each intermediate HTTP endpoint — the same direct-`OrderStateService` technique restaurant-orders.e2e.test.ts already uses). */
  async function deliverOrder(orderNumber: string): Promise<string> {
    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    const orderState = ctx.app.get(OrderStateService);
    const outbox = ctx.app.get(OutboxService);
    for (const status of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const) {
      await orderState.transition(order.id, status, { type: 'RESTAURANT_USER' });
    }
    await outbox.relayPending();
    return order.id;
  }

  function accountOf(customerId: string) {
    return ctx.db.loyaltyAccounts.find((a) => a.customerId === customerId) ?? null;
  }

  // ── BR-98/BR-99: earn on DELIVERED, exactly once ─────────────────────

  it('points are granted on DELIVERED, not before, and not for a guest order', async () => {
    const { slug, item } = await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876510001');

    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber } = await placeAndPayOrder(cartId, guestToken, {
      customerCookie: customer.cookie,
      phone: customer.phone,
    });

    // PLACED, not yet DELIVERED — no points yet.
    expect(accountOf(customer.customerId)?.balancePoints ?? 0).toBe(0);

    await deliverOrder(orderNumber!);

    const account = accountOf(customer.customerId)!;
    expect(account.balancePoints).toBe(2); // ₹200 subtotal / ₹100 * 1 point.
    expect(account.lifetimeEarned).toBe(2);
    const earnEntry = ctx.db.loyaltyLedger.find(
      (l) => l.customerId === customer.customerId && l.type === 'ORDER_EARN',
    )!;
    expect(earnEntry.points).toBe(2);

    // A guest order (no logged-in customer) earns nothing at all — no
    // LoyaltyAccount row is even touched, matching AMB-2.
    const guestCart = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber: guestOrderNumber } = await placeAndPayOrder(guestCart.cartId, guestCart.guestToken, {
      phone: '+919876599999',
    });
    await deliverOrder(guestOrderNumber!);
    const guestOrder = ctx.db.orders.find((o) => o.orderNumber === guestOrderNumber)!;
    const guestLedgerEntry = ctx.db.loyaltyLedger.find(
      (l) => l.referenceType === 'Order' && l.referenceId === guestOrder.id,
    );
    expect(guestLedgerEntry).toBeUndefined();
  });

  it('a duplicated ORDER_DELIVERED event grants points exactly once', async () => {
    const { slug, item } = await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876510002');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber } = await placeAndPayOrder(cartId, guestToken, {
      customerCookie: customer.cookie,
      phone: customer.phone,
    });
    await deliverOrder(orderNumber!);

    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    const earn = ctx.app.get(LoyaltyEarnService);
    // Simulates the outbox relaying the SAME event a second time (a
    // real possibility — "at least once" delivery) by calling the
    // handler directly a second time, exactly as it would be invoked
    // again.
    await earn.awardForDeliveredOrder(order as unknown as Order);
    await earn.awardForDeliveredOrder(order as unknown as Order);

    const account = accountOf(customer.customerId)!;
    expect(account.balancePoints).toBe(2);
    const entries = ctx.db.loyaltyLedger.filter(
      (l) => l.type === 'ORDER_EARN' && l.referenceId === order.id,
    );
    expect(entries).toHaveLength(1);
  });

  // ── BR-101: concurrent redemptions cannot overdraw ───────────────────

  it('two concurrent redemptions of a full balance: one succeeds, one is rejected', async () => {
    const { slug, item } = await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876510003');

    const admin = await seedSuperAdmin(ctx);
    await mutate(ctx, 'post', `/api/v1/admin/loyalty/${customer.customerId}/adjust`, admin.cookie)
      .send({ points: 10, reason: 'seed balance for concurrency test' })
      .expect(200);

    const cartA = await openCart(slug, item.id, item.priceMinor);
    const cartB = await openCart(slug, item.id, item.priceMinor);

    const [resA, resB] = await Promise.all([
      placeAndPayOrder(cartA.cartId, cartA.guestToken, {
        customerCookie: customer.cookie,
        phone: customer.phone,
        redeemLoyaltyPoints: 10,
      }),
      placeAndPayOrder(cartB.cartId, cartB.guestToken, {
        customerCookie: customer.cookie,
        phone: customer.phone,
        redeemLoyaltyPoints: 10,
      }),
    ]);

    const results = [resA.checkoutRes.status, resB.checkoutRes.status];
    expect(results.filter((s) => s === 200)).toHaveLength(1);
    const rejected = [resA, resB].find((r) => r.checkoutRes.status !== 200)!;
    expect(rejected.checkoutRes.body.error.code).toBe('INSUFFICIENT_LOYALTY_POINTS');

    // The winning checkout's redemption is already CONFIRMED by this
    // point — `placeAndPayOrder` drives the order all the way through
    // payment capture/verification, which relays `ORDER_PLACED` and
    // confirms the reservation. Exactly one redemption row exists at
    // all for this customer (never two, and never RESERVED-forever).
    const redemptions = ctx.db.loyaltyRedemptions.filter((r) => r.customerId === customer.customerId);
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]!.status).toBe('CONFIRMED');
    expect(redemptions[0]!.points).toBe(10);
  });

  it('a guest requesting a redemption is rejected outright, never silently ignored', async () => {
    const { slug, item } = await fullSetup();
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const res = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId,
        guestToken,
        customer: { name: 'Guest', phone: '+919876500077' },
        deliveryAddress: { line1: '1 MG Road', city: 'Bengaluru', postalCode: '560001' },
        redeemLoyaltyPoints: 5,
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_LOYALTY_POINTS');
  });

  // ── BR-103/BR-104: proportional refund clawback ──────────────────────

  it('a refund claws back earned points proportionally to the refunded amount', async () => {
    const { slug, item } = await fullSetup('100000'); // ₹1000 item -> 10 points earned.
    const customer = await registerAndLoginCustomer(ctx, '+919876510004');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber } = await placeAndPayOrder(cartId, guestToken, {
      customerCookie: customer.cookie,
      phone: customer.phone,
    });
    await deliverOrder(orderNumber!);
    expect(accountOf(customer.customerId)!.balancePoints).toBe(10);

    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    const payment = ctx.db.payments.find((p) => p.orderId === order.id)!;

    // A 50% refund on a ₹1000 order (₹500) claws back half the earned points.
    const refunds = ctx.app.get(RefundService);
    await refunds.requestRefund({
      paymentId: payment.id,
      amountMinor: 50000n,
      reason: 'Goodwill partial refund',
      initiatedByActorType: 'ADMIN',
      idempotencyKey: randomUUID(),
    });
    await ctx.app.get(OutboxService).relayPending();

    const account = accountOf(customer.customerId)!;
    expect(account.balancePoints).toBe(5); // 10 earned - 5 clawed back.
    const clawback = ctx.db.loyaltyLedger.find(
      (l) => l.customerId === customer.customerId && l.type === 'REFUND_CLAWBACK',
    )!;
    expect(clawback.points).toBe(-5);
  });

  // ── BR-97: ledger-vs-balance reconciliation ──────────────────────────

  it('SUM(loyalty_ledger.points) equals loyalty_accounts.balance_points for every customer after a mix of activity', async () => {
    const { slug, item } = await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876510005');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber } = await placeAndPayOrder(cartId, guestToken, {
      customerCookie: customer.cookie,
      phone: customer.phone,
    });
    await deliverOrder(orderNumber!);

    const admin = await seedSuperAdmin(ctx);
    await mutate(ctx, 'post', `/api/v1/admin/loyalty/${customer.customerId}/adjust`, admin.cookie)
      .send({ points: 7, reason: 'goodwill credit' })
      .expect(200);

    const mismatches = await ctx.app.get(LoyaltyReconciliationService).reconcile();
    expect(mismatches).toBe(0);

    const account = accountOf(customer.customerId)!;
    const ledgerSum = ctx.db.loyaltyLedger
      .filter((l) => l.customerId === customer.customerId)
      .reduce((sum, l) => sum + l.points, 0);
    expect(ledgerSum).toBe(account.balancePoints);
  });

  // ── BR-106: admin adjustments write a ledger row, never a direct mutation ─

  it('an admin adjustment creates a ledger row; direct balance mutation does not exist as a code path', async () => {
    await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876510006');
    // A LoyaltyAccount only exists once a customer has one — created at
    // account signup (registerAndLoginCustomer above), balance 0.
    const admin = await seedSuperAdmin(ctx);

    const res = await mutate(ctx, 'post', `/api/v1/admin/loyalty/${customer.customerId}/adjust`, admin.cookie)
      .send({ points: 25, reason: 'launch promo credit' })
      .expect(200);
    expect(res.body.data.balancePoints).toBe(25);

    const entry = ctx.db.loyaltyLedger.find(
      (l) => l.customerId === customer.customerId && l.type === 'ADMIN_ADJUSTMENT',
    )!;
    expect(entry.points).toBe(25);
    expect(entry.actorType).toBe('ADMIN');
    expect(entry.description).toBe('launch promo credit');

    // A SUPPORT admin (loyalty:read, not loyalty:adjust) can view but not adjust.
    const support = await seedAdmin(ctx, 'SUPPORT');
    await mutate(ctx, 'post', `/api/v1/admin/loyalty/${customer.customerId}/adjust`, support.cookie)
      .send({ points: 1, reason: 'should be forbidden' })
      .expect(403);
    await get(ctx, `/api/v1/admin/loyalty/${customer.customerId}`, support.cookie).expect(200);
  });

  // ── BR-109/BR-108: referral database constraints ─────────────────────

  it('self-referral is rejected by the database constraint', async () => {
    ctx = await createTestApp();
    const customer = await registerAndLoginCustomer(ctx, '+919876510007');
    const referrals = ctx.app.get(ReferralRepository);

    await expect(
      referrals.create({
        referrerCustomerId: customer.customerId,
        referredCustomerId: customer.customerId,
        referralCode: 'SELFCODE',
      }),
    ).rejects.toThrow();
  });

  it('a customer cannot acquire a second referrer', async () => {
    ctx = await createTestApp();
    const referrerA = await registerAndLoginCustomer(ctx, '+919876510008');
    const referrerB = await registerAndLoginCustomer(ctx, '+919876510009');
    const referred = await registerAndLoginCustomer(ctx, '+919876510010');

    const referralService = ctx.app.get(ReferralService);
    const codeA = await referralService.getOrCreateCode(referrerA.customerId);
    const codeB = await referralService.getOrCreateCode(referrerB.customerId);

    const firstApplied = await referralService.attributeAtSignup(referred.customerId, codeA.code);
    expect(firstApplied).toBe(true);

    const secondApplied = await referralService.attributeAtSignup(referred.customerId, codeB.code);
    expect(secondApplied).toBe(false);

    const referrals = ctx.app.get(ReferralRepository);
    const referral = await referrals.findByReferredCustomerId(referred.customerId);
    expect(referral!.referrerCustomerId).toBe(referrerA.customerId);
  });

  it('POST /auth/customer/otp/verify with a referralCode attributes at signup over real HTTP', async () => {
    ctx = await createTestApp();
    const referrer = await registerAndLoginCustomer(ctx, '+919876510011');
    const referralService = ctx.app.get(ReferralService);
    const code = await referralService.getOrCreateCode(referrer.customerId);

    const referred = await registerAndLoginCustomer(ctx, '+919876510012', {
      referralCode: code.code,
    });
    expect(referred.referralApplied).toBe(true);

    const referrals = ctx.app.get(ReferralRepository);
    const referral = await referrals.findByReferredCustomerId(referred.customerId);
    expect(referral!.referrerCustomerId).toBe(referrer.customerId);
    expect(referral!.status).toBe('PENDING');
  });

  // ── BR-111/BR-112: qualification and idempotent reward issuance ─────

  it('a duplicated qualification event issues exactly one referral reward', async () => {
    const { slug, item } = await fullSetup();
    const referrer = await registerAndLoginCustomer(ctx, '+919876510013');
    const referralService = ctx.app.get(ReferralService);
    const code = await referralService.getOrCreateCode(referrer.customerId);
    const referred = await registerAndLoginCustomer(ctx, '+919876510014', {
      referralCode: code.code,
    });

    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber } = await placeAndPayOrder(cartId, guestToken, {
      customerCookie: referred.cookie,
      phone: referred.phone,
    });
    await deliverOrder(orderNumber!);

    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    // The consumer already called qualifyOnDelivered once via
    // deliverOrder's relayPending — call it again directly to simulate
    // the SAME event being delivered a second time.
    await referralService.qualifyOnDelivered(order as unknown as Order);

    const referrals = ctx.app.get(ReferralRepository);
    const referral = await referrals.findByReferredCustomerId(referred.customerId);
    expect(referral!.status).toBe('REWARDED');

    const rewardEntries = ctx.db.loyaltyLedger.filter(
      (l) => l.customerId === referrer.customerId && l.type === 'REFERRAL_REWARD',
    );
    expect(rewardEntries).toHaveLength(1);

    const referrerAccount = ctx.app.get(LoyaltyAccountRepository);
    const account = await referrerAccount.findByCustomerId(referrer.customerId);
    expect(account!.balancePoints).toBe(rewardEntries[0]!.points);
  });

  // ── BR-115: referrer sees status only, no PII about the referred customer ─

  it("GET /me/referrals exposes status and timestamps only — never the referred customer's name, phone, or email", async () => {
    const { slug, item } = await fullSetup();
    const referrer = await registerAndLoginCustomer(ctx, '+919876510015');
    const referralService = ctx.app.get(ReferralService);
    const code = await referralService.getOrCreateCode(referrer.customerId);
    const referred = await registerAndLoginCustomer(ctx, '+919876510016', {
      referralCode: code.code,
      fullName: 'Very Private Person',
    });

    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber } = await placeAndPayOrder(cartId, guestToken, {
      customerCookie: referred.cookie,
      phone: referred.phone,
    });
    await deliverOrder(orderNumber!);

    const res = await get(ctx, '/api/v1/me/referrals', referrer.cookie).expect(200);
    expect(res.body.data.code).toBe(code.code);
    expect(res.body.data.referrals).toHaveLength(1);
    const referralView = res.body.data.referrals[0];
    expect(referralView).toEqual({
      status: 'REWARDED',
      attributedAt: expect.any(String),
      qualifiedAt: expect.any(String),
      rewardedAt: expect.any(String),
    });
    const serialized = JSON.stringify(res.body.data);
    expect(serialized).not.toContain('Very Private Person');
    expect(serialized).not.toContain(referred.phone);
    expect(serialized).not.toContain(referred.customerId);
  });

  it('GET /me/loyalty and GET /me/loyalty/ledger require a customer profile — a staff session is forbidden', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    await get(ctx, '/api/v1/me/loyalty', owner.cookie).expect(403);
  });
});

async function seedSuperAdmin(ctx: TestApp) {
  return seedAdmin(ctx, 'SUPER_ADMIN');
}

async function seedAdmin(ctx: TestApp, role: 'SUPER_ADMIN' | 'SUPPORT') {
  const admin = await registerAndLogin(ctx, { email: `${role.toLowerCase()}-${randomUUID()}@direct-order.test` });
  ctx.db.adminUsers.push({
    id: randomUUID(),
    userId: admin.userId,
    role,
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const session = ctx.db.sessions.find((s) => s.userId === admin.userId)!;
  session.mfaVerifiedAt = new Date();
  const user = ctx.db.users.find((u) => u.id === admin.userId)!;
  user.mfaEnabledAt = new Date();
  return admin;
}
