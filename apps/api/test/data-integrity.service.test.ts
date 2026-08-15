import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { mutate, registerAndLogin, type RegisteredUser } from './support/register-and-login.js';
import { DataIntegrityService } from '../src/modules/data-integrity/services/data-integrity.service.js';

/**
 * Phase 19 — docs/11-testing-strategy.md §18.6's six named data-
 * integrity assertions, "run after the full suite and on a schedule
 * in production." Each test seeds exactly the violation the assertion
 * is meant to catch, confirms it's detected and recorded as a
 * `ReconciliationIssue` (so it surfaces via the existing `GET
 * /admin/reconciliation-issues`, no new endpoint needed), and confirms
 * a clean dataset reports zero.
 */
describe('DataIntegrityService (Phase 19)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  async function setUpRestaurant(
    owner: RegisteredUser,
  ): Promise<{ slug: string; restaurantId: string; itemId: string }> {
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
    const item = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
      .send({ categoryId: category.body.data.id, name: 'Thali', priceMinor: '20000' })
      .expect(201);

    return { slug, restaurantId, itemId: item.body.data.id as string };
  }

  async function placedOrder(): Promise<{ orderId: string; restaurantId: string }> {
    const owner = await registerAndLogin(ctx);
    const { slug, itemId, restaurantId } = await setUpRestaurant(owner);
    const cartRes = await mutate(ctx, 'post', '/api/v1/public/carts')
      .send({ restaurantSlug: slug, items: [{ itemId, quantity: 1, unitPriceMinorAtAdd: '20000' }] })
      .expect(201);
    const checkoutRes = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId: cartRes.body.data.cartId,
        guestToken: cartRes.body.data.guestToken,
        customer: { name: 'Asha Customer', phone: '+919876500097' },
        deliveryAddress: { line1: '1 MG Road', city: 'Bengaluru', postalCode: '560001' },
      })
      .expect(200);
    const { orderNumber, accessToken } = checkoutRes.body.data;
    const simulateRes = await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/simulate-payment`)
      .send({ token: accessToken, outcome: 'CAPTURED' })
      .expect(200);
    await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/verify-payment`)
      .send({ token: accessToken, providerPaymentId: simulateRes.body.data.providerPaymentId })
      .expect(200);
    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    return { orderId: order.id, restaurantId };
  }

  it('a clean dataset reports zero violations for every assertion', async () => {
    ctx = await createTestApp();
    await placedOrder();
    const results = await ctx.app.get(DataIntegrityService).runAll();
    for (const r of results) {
      expect(r.violations, r.assertion).toBe(0);
    }
    expect(ctx.db.reconciliationIssues).toHaveLength(0);
  });

  it('ORDER_TOTAL_IDENTITY: does not false-positive on a real order combining a promotion and a loyalty redemption (found live against real dev data — Order.discountMinor already includes loyaltyDiscountMinor, it is not a second amount to subtract again)', async () => {
    ctx = await createTestApp();
    const { orderId } = await placedOrder();
    const order = ctx.db.orders.find((o) => o.id === orderId)!;
    // Mirrors what checkout.service.ts actually persists: discountMinor
    // is promotionDiscountMinor + loyaltyDiscountMinor already combined
    // (packages/money/src/pricing.ts's PricingBreakdown.discountMinor),
    // here 0 (promotion) + 500 (loyalty) = 500 combined.
    order.discountMinor = 500n;
    order.loyaltyDiscountMinor = 500n;
    order.payableTotalMinor = order.payableTotalMinor - 500n;

    const results = await ctx.app.get(DataIntegrityService).runAll();
    expect(results.find((r) => r.assertion === 'ORDER_TOTAL_IDENTITY')!.violations).toBe(0);
    expect(ctx.db.reconciliationIssues).toHaveLength(0);
  });

  it('ORDER_TOTAL_IDENTITY: detects an order whose payableTotalMinor does not match its own line items', async () => {
    ctx = await createTestApp();
    const { orderId } = await placedOrder();
    const order = ctx.db.orders.find((o) => o.id === orderId)!;
    order.payableTotalMinor = order.payableTotalMinor + 100n; // corrupt it

    const results = await ctx.app.get(DataIntegrityService).runAll();
    expect(results.find((r) => r.assertion === 'ORDER_TOTAL_IDENTITY')!.violations).toBe(1);
    const issue = ctx.db.reconciliationIssues.find((i) => i.issueType === 'ORDER_TOTAL_IDENTITY_VIOLATION');
    expect(issue?.entityId).toBe(orderId);
    expect(issue?.severity).toBe('CRITICAL');
  });

  it('NO_OVER_REFUND: detects a payment where refundedMinor exceeds capturedMinor', async () => {
    ctx = await createTestApp();
    await placedOrder();
    const payment = ctx.db.payments[0]!;
    payment.refundedMinor = payment.capturedMinor + 500n; // corrupt it directly — bypassing RefundService's own guard, exactly the class of bug this assertion exists to catch independent of application-layer enforcement.

    const results = await ctx.app.get(DataIntegrityService).runAll();
    expect(results.find((r) => r.assertion === 'NO_OVER_REFUND')!.violations).toBe(1);
    const issue = ctx.db.reconciliationIssues.find((i) => i.issueType === 'OVER_REFUND');
    expect(issue?.entityId).toBe(payment.id);
  });

  it('NO_DUPLICATE_DELIVERY_PER_ORDER: detects two Delivery rows sharing the same orderId', async () => {
    ctx = await createTestApp();
    const { orderId } = await placedOrder();
    // Delivery.@@unique([orderId]) makes this impossible via the real create() path — seeded directly, the same "prove the constraint holds" reasoning the assertion itself documents.
    const base = {
      id: randomUUID(),
      orderId,
      provider: 'mock',
      providerDeliveryId: null,
      status: 'CREATED',
      pickupAddress: {},
      dropoffAddress: {},
      courierName: null,
      courierPhone: null,
      trackingUrl: null,
      quotedFeeMinor: null,
      actualFeeMinor: null,
      idempotencyKey: randomUUID(),
      attemptCount: 0,
      estimatedPickupAt: null,
      estimatedDeliveryAt: null,
      pickedUpAt: null,
      deliveredAt: null,
      cancellationReason: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    ctx.db.deliveries.push({ ...base, id: randomUUID() }, { ...base, id: randomUUID() });

    const results = await ctx.app.get(DataIntegrityService).runAll();
    expect(results.find((r) => r.assertion === 'NO_DUPLICATE_DELIVERY_PER_ORDER')!.violations).toBe(1);
    const issue = ctx.db.reconciliationIssues.find((i) => i.issueType === 'DUPLICATE_DELIVERY_PER_ORDER');
    expect(issue?.entityId).toBe(orderId);
  });

  it('LOYALTY_BALANCE_MATCHES_LEDGER: delegates to LoyaltyReconciliationService and reports its mismatch count', async () => {
    ctx = await createTestApp();
    const customer = { id: randomUUID(), userId: null, fullName: 'Test', phone: '+919876500096', email: null, status: 'ACTIVE' as const, marketingConsentAt: null, createdAt: new Date(), updatedAt: new Date() };
    ctx.db.customers.push(customer);
    ctx.db.loyaltyAccounts.push({
      id: randomUUID(),
      customerId: customer.id,
      balancePoints: 999, // no matching ledger entries at all
      lifetimeEarned: 0,
      lifetimeRedeemed: 0,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const results = await ctx.app.get(DataIntegrityService).runAll();
    expect(results.find((r) => r.assertion === 'LOYALTY_BALANCE_MATCHES_LEDGER')!.violations).toBe(1);
    expect(
      ctx.db.reconciliationIssues.find((i) => i.issueType === 'LOYALTY_BALANCE_MISMATCH'),
    ).toBeDefined();
  });

  it('NO_ORDER_PLACED_WITHOUT_CAPTURED_PAYMENT: detects a PLACED order whose payment was never actually captured', async () => {
    ctx = await createTestApp();
    const { orderId } = await placedOrder();
    const payment = ctx.db.payments.find((p) => p.orderId === orderId)!;
    payment.capturedMinor = 0n; // simulate the order's status having advanced without a real capture

    const results = await ctx.app.get(DataIntegrityService).runAll();
    expect(
      results.find((r) => r.assertion === 'NO_ORDER_PLACED_WITHOUT_CAPTURED_PAYMENT')!.violations,
    ).toBe(1);
    const issue = ctx.db.reconciliationIssues.find(
      (i) => i.issueType === 'ORDER_PLACED_WITHOUT_CAPTURED_PAYMENT',
    );
    expect(issue?.entityId).toBe(orderId);
  });

  it('NO_REFERRAL_REWARDED_TWICE: detects two REFERRAL_REWARD ledger entries sharing the same referenceId', async () => {
    ctx = await createTestApp();
    const customerId = randomUUID();
    ctx.db.customers.push({
      id: customerId,
      userId: null,
      fullName: 'Referrer',
      phone: '+919876500095',
      email: null,
      status: 'ACTIVE',
      marketingConsentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const referenceId = randomUUID();
    for (let i = 0; i < 2; i++) {
      ctx.db.loyaltyLedger.push({
        id: randomUUID(),
        customerId,
        type: 'REFERRAL_REWARD',
        points: 50,
        referenceType: 'Referral',
        referenceId,
        description: null,
        actorType: 'SYSTEM',
        actorId: null,
        createdAt: new Date(),
      });
    }

    const results = await ctx.app.get(DataIntegrityService).runAll();
    expect(results.find((r) => r.assertion === 'NO_REFERRAL_REWARDED_TWICE')!.violations).toBe(1);
    const issue = ctx.db.reconciliationIssues.find((i) => i.issueType === 'REFERRAL_REWARDED_TWICE');
    expect(issue?.entityId).toBe(referenceId);
  });
});
