import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../../platform/errors/app-error.js';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { LoyaltyAccountRepository } from '../repositories/loyalty-account.repository.js';
import { LoyaltyLedgerRepository } from '../repositories/loyalty-ledger.repository.js';
import { LoyaltyRedemptionRepository } from '../repositories/loyalty-redemption.repository.js';

/**
 * No spec source names a redemption conversion rate (unlike the earn
 * side, AMB-11's `LOYALTY_POINTS_PER_100_INR`) — a documented
 * code-level default, same treatment as Phase 15's Bayesian rating
 * constants. ₹1 (100 minor units) per point: combined with the earn
 * default of 1 point per ₹100 spent, this is a 1% reward rate, a
 * realistic, easily-explainable loyalty economics choice for a pilot.
 */
export const LOYALTY_REDEMPTION_MINOR_PER_POINT = 100n;

export function pointsToMinor(points: number): bigint {
  return BigInt(points) * LOYALTY_REDEMPTION_MINOR_PER_POINT;
}

/** BR-104/AMB-12: converts a discount amount that was DOWNWARD-clamped by the pricing engine (e.g. an order too small to use every requested point) back into the smaller point count actually being spent — a customer is never charged points for value they didn't receive as discount. */
export function minorToPoints(discountMinor: bigint): number {
  return Number(discountMinor / LOYALTY_REDEMPTION_MINOR_PER_POINT);
}

export function insufficientPointsError(): AppError {
  return new AppError(
    'INSUFFICIENT_LOYALTY_POINTS',
    409,
    'You do not have enough loyalty points for this redemption.',
  );
}

export interface CheckRedemptionInput {
  customerId: string;
  /** The FINAL points to spend — already reconciled against any pricing-engine clamp by the caller (see `minorToPoints`). */
  points: number;
}

/**
 * BR-101/BR-102: "redemption locks the account row; concurrent
 * redemptions cannot overdraw" and "reserved at checkout, confirmed on
 * payment capture, mirroring coupons" — structurally identical to
 * `PromotionReservationService.checkAndLock`: runs inside the SAME
 * transaction as Order creation, real `SELECT ... FOR UPDATE`, does NOT
 * write the `LoyaltyRedemption` row itself (the caller creates it as a
 * nested write under `Order.create`, same reasoning as promotions).
 *
 * The lock alone is not sufficient to prevent overdraw across two
 * concurrent redemption attempts, because `balancePoints` is only
 * decremented at CONFIRM time (payment capture), not at reservation —
 * so this also subtracts every currently-RESERVED-but-unconfirmed
 * points total for this customer from the locked balance before
 * checking. Two concurrent checkouts both attempting to spend the same
 * customer's full balance therefore serialise correctly: the second to
 * acquire the lock sees the first's now-committed RESERVED row in the
 * aggregate and is rejected.
 */
@Injectable()
export class LoyaltyRedemptionService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LoyaltyAccountRepository) private readonly accounts: LoyaltyAccountRepository,
    @Inject(LoyaltyLedgerRepository) private readonly ledger: LoyaltyLedgerRepository,
    @Inject(LoyaltyRedemptionRepository) private readonly redemptions: LoyaltyRedemptionRepository,
  ) {}

  async checkAndLock(
    tx: Prisma.TransactionClient,
    input: CheckRedemptionInput,
  ): Promise<{ points: number; discountMinor: bigint }> {
    if (input.points <= 0) {
      throw insufficientPointsError();
    }

    const locked = await this.accounts.lockByCustomerId(tx, input.customerId);
    if (!locked) {
      throw insufficientPointsError();
    }

    // AMB-12: a negative balance blocks redemption entirely rather than
    // being clamped to zero — `available` below is negative in that
    // case too, so `input.points > available` is true for ANY positive
    // request, correctly rejecting it without a separate branch.
    const alreadyReserved = await this.redemptions.sumReservedByCustomerId(tx, input.customerId);
    const available = locked.balancePoints - alreadyReserved;

    if (input.points > available) {
      throw insufficientPointsError();
    }

    return { points: input.points, discountMinor: pointsToMinor(input.points) };
  }

  /**
   * BR-102's confirm half, driven by `LoyaltyOutboxConsumer` on
   * `ORDER_PLACED` (payment captured) — mirrors
   * `PromotionOutboxConsumer.confirm`, plus the ledger write promotions
   * never needed: THIS is the one and only place a redemption actually
   * debits the account (see `LoyaltyRedemption`'s own doc comment for
   * why the reservation itself never touches the ledger). A no-op for
   * the common case of an order with no redemption at all.
   */
  async confirm(orderId: string): Promise<void> {
    const confirmed = await this.redemptions.confirmByOrderId(orderId);
    if (!confirmed) return;

    await this.prisma.$transaction(async (tx) => {
      await this.ledger.create(tx, {
        customerId: confirmed.customerId,
        type: 'REDEMPTION',
        points: -confirmed.points,
        referenceType: 'Order',
        referenceId: orderId,
        description: `Redeemed on order ${orderId}`,
      });
      await this.accounts.applyDelta(tx, confirmed.customerId, {
        balancePoints: -confirmed.points,
        lifetimeRedeemed: confirmed.points,
      });
    });
  }

  /** BR-102's release half, driven by `ORDER_PAYMENT_FAILED`/`ORDER_EXPIRED` — never touches the ledger or balance, since a RESERVED redemption was never applied to either in the first place. */
  async release(orderId: string): Promise<void> {
    await this.redemptions.releaseByOrderId(orderId);
  }
}
