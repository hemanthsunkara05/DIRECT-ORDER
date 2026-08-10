import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { OrderExpiryScheduler } from '../src/modules/orders/services/order-expiry.scheduler.js';
import type { OrderRow } from './support/in-memory-prisma.js';

/** docs/03 §7.1: PENDING_PAYMENT → EXPIRED, "Older than ORDER_PAYMENT_TTL_MINUTES (default 30), no capture." */
describe('OrderExpiryScheduler (Phase 9)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  function seedOrder(status: string, createdAt: Date): OrderRow {
    const row: OrderRow = {
      id: randomUUID(),
      orderNumber: `DO-TEST-${randomUUID().slice(0, 5).toUpperCase()}`,
      restaurantId: randomUUID(),
      customerId: randomUUID(),
      status,
      customerName: 'Asha Customer',
      customerPhone: '+919876543210',
      deliveryAddress: {},
      itemsSubtotalMinor: 10000n,
      packagingFeeMinor: 0n,
      deliveryFeeMinor: 0n,
      platformFeeMinor: 0n,
      taxMinor: 0n,
      discountMinor: 0n,
      loyaltyDiscountMinor: 0n,
      payableTotalMinor: 10000n,
      currency: 'INR',
      pricingBreakdown: {},
      promotionId: null,
      couponCode: null,
      appliedLoyaltyPoints: 0,
      idempotencyKey: randomUUID(),
      accessTokenHash: 'hash',
      placedAt: null,
      acceptedAt: null,
      readyAt: null,
      deliveredAt: null,
      cancelledAt: null,
      rejectionReason: null,
      cancellationReason: null,
      createdAt,
      updatedAt: createdAt,
    };
    ctx.db.orders.push(row);
    return row;
  }

  it('expires a PENDING_PAYMENT order older than the TTL', async () => {
    ctx = await createTestApp({ ORDER_PAYMENT_TTL_MINUTES: 30 });
    const scheduler = ctx.app.get(OrderExpiryScheduler);
    const stale = seedOrder('PENDING_PAYMENT', new Date(Date.now() - 31 * 60_000));

    const count = await scheduler.runOnce();

    expect(count).toBe(1);
    expect(ctx.db.orders.find((o) => o.id === stale.id)!.status).toBe('EXPIRED');
  });

  it('leaves a recent PENDING_PAYMENT order (within the TTL) untouched', async () => {
    ctx = await createTestApp({ ORDER_PAYMENT_TTL_MINUTES: 30 });
    const scheduler = ctx.app.get(OrderExpiryScheduler);
    const fresh = seedOrder('PENDING_PAYMENT', new Date(Date.now() - 5 * 60_000));

    const count = await scheduler.runOnce();

    expect(count).toBe(0);
    expect(ctx.db.orders.find((o) => o.id === fresh.id)!.status).toBe('PENDING_PAYMENT');
  });

  it('never touches orders in other statuses, even if old', async () => {
    ctx = await createTestApp({ ORDER_PAYMENT_TTL_MINUTES: 30 });
    const scheduler = ctx.app.get(OrderExpiryScheduler);
    const placed = seedOrder('PLACED', new Date(Date.now() - 60 * 60_000));

    const count = await scheduler.runOnce();

    expect(count).toBe(0);
    expect(ctx.db.orders.find((o) => o.id === placed.id)!.status).toBe('PLACED');
  });
});
