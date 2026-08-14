import { Inject, Injectable } from '@nestjs/common';
import type { Order } from '@prisma/client';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { isUniqueConstraintViolation } from '../../../platform/database/prisma-errors.js';
import { CustomerRepository } from '../../orders/repositories/customer.repository.js';
import { LoyaltyAccountRepository } from '../repositories/loyalty-account.repository.js';
import { LoyaltyLedgerRepository } from '../repositories/loyalty-ledger.repository.js';

const ITEMS_SUBTOTAL_UNIT_MINOR = 10_000n; // ₹100 in minor units (paise).

/** BR-100/AMB-11: `floor(itemsSubtotalMinor / ₹100) * LOYALTY_POINTS_PER_100_INR` — integer BigInt division, never a float. Fees, tax, and discounts are excluded by construction: only `itemsSubtotalMinor` is an input. */
export function computeEarnedPoints(itemsSubtotalMinor: bigint, pointsPer100Inr: number): number {
  const hundredsSpent = itemsSubtotalMinor / ITEMS_SUBTOTAL_UNIT_MINOR;
  return Number(hundredsSpent) * pointsPer100Inr;
}

/**
 * BR-98/BR-99: "points are earned when an order reaches DELIVERED, not
 * before" and "an order can never award twice" — the second guarantee
 * comes entirely from `loyalty_ledger`'s hand-written partial unique
 * index on `(type, reference_type, reference_id)`, not from a
 * pre-check: this method always attempts the insert and treats a
 * P2002 as "already awarded, nothing to do", the same
 * insert-and-let-the-constraint-decide pattern used everywhere else in
 * this codebase (Order idempotency keys, Delivery dispatch uniqueness,
 * `Review.orderId`). That is what makes "a duplicated ORDER_DELIVERED
 * event grants points exactly once" hold under real concurrency, not
 * just in the common sequential case.
 *
 * AMB-2: guests do not earn loyalty points — `Customer.userId === null`
 * means guest, checked before ever attempting the ledger write (not
 * relied on to fail some other way), so a guest order never even
 * produces a failed insert attempt to swallow.
 */
@Injectable()
export class LoyaltyEarnService {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CustomerRepository) private readonly customers: CustomerRepository,
    @Inject(LoyaltyAccountRepository) private readonly accounts: LoyaltyAccountRepository,
    @Inject(LoyaltyLedgerRepository) private readonly ledger: LoyaltyLedgerRepository,
  ) {}

  async awardForDeliveredOrder(order: Order): Promise<void> {
    const customer = await this.customers.findById(order.customerId);
    if (!customer || !customer.userId) {
      return; // guest order — AMB-2, no points.
    }

    const points = computeEarnedPoints(order.itemsSubtotalMinor, this.env.LOYALTY_POINTS_PER_100_INR);
    if (points <= 0) {
      return; // an order too small to earn a single whole point.
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.ledger.create(tx, {
          customerId: customer.id,
          type: 'ORDER_EARN',
          points,
          referenceType: 'Order',
          referenceId: order.id,
          description: `Earned on order ${order.orderNumber}`,
        });
        await this.accounts.applyDelta(tx, customer.id, {
          balancePoints: points,
          lifetimeEarned: points,
        });
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        return; // already awarded for this order — duplicate event, no-op.
      }
      throw error;
    }
  }
}
