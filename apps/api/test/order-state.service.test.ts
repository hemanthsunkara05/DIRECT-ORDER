import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { OrderStateService } from '../src/modules/orders/services/order-state.service.js';
import type { OrderRow } from './support/in-memory-prisma.js';

/**
 * Unit-level coverage of the full order state graph
 * (docs/03-state-machines.md §7.1) via `OrderStateService` directly —
 * most of these edges (everything past PLACED) have no HTTP path yet
 * (see OrderStatus's doc comment in schema.prisma), so this is the only
 * way to exercise them this phase. `checkout.e2e.test.ts` already
 * covers the two edges that DO have an HTTP path
 * (PENDING_PAYMENT → PLACED/PAYMENT_FAILED) end-to-end.
 */
describe('OrderStateService (Phase 9)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  function seedOrder(status: string): OrderRow {
    const row: OrderRow = {
      id: randomUUID(),
      orderNumber: `DO-TEST-${randomUUID().slice(0, 5).toUpperCase()}`,
      restaurantId: randomUUID(),
      customerId: randomUUID(),
      status,
      customerName: 'Asha Customer',
      customerPhone: '+919876543210',
      deliveryAddress: { line1: 'x', city: 'Bengaluru', postalCode: '560001' },
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
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    ctx.db.orders.push(row);
    return row;
  }

  it('allows every documented legal edge in the full graph', async () => {
    ctx = await createTestApp();
    const orderState = ctx.app.get(OrderStateService);

    const edges: [string, string][] = [
      ['PENDING_PAYMENT', 'PLACED'],
      ['PENDING_PAYMENT', 'PAYMENT_FAILED'],
      ['PENDING_PAYMENT', 'EXPIRED'],
      ['PAYMENT_FAILED', 'PENDING_PAYMENT'],
      ['PLACED', 'ACCEPTED'],
      ['PLACED', 'REJECTED'],
      ['PLACED', 'CANCELLED'],
      ['ACCEPTED', 'PREPARING'],
      ['ACCEPTED', 'CANCELLED'],
      ['PREPARING', 'READY_FOR_PICKUP'],
      ['PREPARING', 'CANCELLED'],
      ['READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'],
      ['READY_FOR_PICKUP', 'CANCELLED'],
      ['OUT_FOR_DELIVERY', 'DELIVERED'],
      ['OUT_FOR_DELIVERY', 'DELIVERY_FAILED'],
      ['DELIVERY_FAILED', 'OUT_FOR_DELIVERY'],
      ['DELIVERY_FAILED', 'CANCELLED'],
    ];

    for (const [from, to] of edges) {
      const order = seedOrder(from);
      const requiresReason = to === 'REJECTED' || to === 'CANCELLED';
      const result = await orderState.transition(
        order.id,
        to as never,
        { type: 'SYSTEM' },
        requiresReason ? { reason: 'test' } : {},
      );
      expect(result.applied).toBe(true);
      expect(result.order.status).toBe(to);
    }
  });

  it('rejects every explicitly forbidden edge with 409 and the current state', async () => {
    ctx = await createTestApp();
    const orderState = ctx.app.get(OrderStateService);

    const forbidden: [string, string][] = [
      ['DELIVERED', 'PREPARING'], // terminal -> *
      ['CANCELLED', 'PLACED'], // terminal -> *
      ['REJECTED', 'PLACED'], // terminal -> *
      ['EXPIRED', 'PENDING_PAYMENT'], // terminal -> *
      ['PLACED', 'PREPARING'], // must accept first
      ['ACCEPTED', 'READY_FOR_PICKUP'], // must pass through PREPARING
      ['PREPARING', 'ACCEPTED'], // backwards
    ];

    for (const [from, to] of forbidden) {
      const order = seedOrder(from);
      await expect(
        orderState.transition(order.id, to as never, { type: 'SYSTEM' }),
      ).rejects.toMatchObject({
        httpStatus: 409,
        code: 'CONFLICT',
      });
      // Never actually changed.
      expect(ctx.db.orders.find((o) => o.id === order.id)!.status).toBe(from);
    }
  });

  it('re-requesting the current state is idempotent: 200, not 409, and no duplicate history row', async () => {
    ctx = await createTestApp();
    const orderState = ctx.app.get(OrderStateService);
    const order = seedOrder('PLACED');

    const result = await orderState.transition(order.id, 'PLACED', { type: 'SYSTEM' });
    expect(result.applied).toBe(false);
    expect(result.order.status).toBe('PLACED');
    expect(ctx.db.orderStatusHistory.filter((h) => h.orderId === order.id)).toHaveLength(0);
  });

  it('requires a reason for REJECTED and CANCELLED, not for other transitions', async () => {
    ctx = await createTestApp();
    const orderState = ctx.app.get(OrderStateService);

    const toReject = seedOrder('PLACED');
    await expect(
      orderState.transition(toReject.id, 'REJECTED', { type: 'RESTAURANT_USER' }),
    ).rejects.toMatchObject({ httpStatus: 409 });

    const toCancel = seedOrder('PLACED');
    await expect(
      orderState.transition(toCancel.id, 'CANCELLED', { type: 'ADMIN' }),
    ).rejects.toMatchObject({ httpStatus: 409 });

    const toAccept = seedOrder('PLACED');
    const result = await orderState.transition(toAccept.id, 'ACCEPTED', {
      type: 'RESTAURANT_USER',
    });
    expect(result.applied).toBe(true);
  });

  it('records fromStatus/toStatus/actorType/reason on the append-only history row', async () => {
    ctx = await createTestApp();
    const orderState = ctx.app.get(OrderStateService);
    const order = seedOrder('PLACED');

    await orderState.transition(
      order.id,
      'REJECTED',
      { type: 'RESTAURANT_USER', id: 'staff-1' },
      {
        reason: 'Out of ingredients',
      },
    );

    const history = ctx.db.orderStatusHistory.filter((h) => h.orderId === order.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: 'PLACED',
      toStatus: 'REJECTED',
      actorType: 'RESTAURANT_USER',
      actorId: 'staff-1',
      reason: 'Out of ingredients',
    });
  });

  it('writes an outbox event on every applied transition, never on an idempotent replay', async () => {
    ctx = await createTestApp();
    const orderState = ctx.app.get(OrderStateService);
    const order = seedOrder('PLACED');

    await orderState.transition(order.id, 'ACCEPTED', { type: 'RESTAURANT_USER' });
    expect(ctx.db.outboxEvents).toHaveLength(1);

    await orderState.transition(order.id, 'ACCEPTED', { type: 'RESTAURANT_USER' });
    expect(ctx.db.outboxEvents).toHaveLength(1); // replay — no second event
  });
});
