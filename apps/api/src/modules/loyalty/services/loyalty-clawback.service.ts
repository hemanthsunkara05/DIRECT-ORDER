import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { isUniqueConstraintViolation } from '../../../platform/database/prisma-errors.js';
import { LoyaltyAccountRepository } from '../repositories/loyalty-account.repository.js';
import { LoyaltyLedgerRepository } from '../repositories/loyalty-ledger.repository.js';

/**
 * BR-103/BR-104/AMB-12: "a refunded order claws back its earned points
 * proportionally to the refunded amount" — proportional to how much of
 * the order's `payableTotalMinor` this specific refund represents,
 * applied against however many points were actually earned on that
 * order (0 for a guest order, or one that earned less than one whole
 * point — nothing to claw back either way). "Clawback may drive the
 * balance negative; redemption is blocked while negative" — this NEVER
 * clamps at zero (see `LoyaltyAccountRepository`'s own doc comment: no
 * method here forgives a debt, only `LoyaltyRedemptionService` reads
 * the resulting negative balance and refuses further redemption).
 *
 * Keyed by `(REFUND_CLAWBACK, 'Refund', refundId)`, not by order — a
 * single order can have multiple partial refunds, each clawing back
 * its own proportional share exactly once (refund completion is
 * itself already idempotent, via `Refund.idempotencyKey` and
 * `RefundService`'s own P2002 handling, so a duplicated
 * `REFUND_COMPLETED` event reaching here a second time collides on
 * this same key and is a safe no-op).
 */
@Injectable()
export class LoyaltyClawbackService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LoyaltyAccountRepository) private readonly accounts: LoyaltyAccountRepository,
    @Inject(LoyaltyLedgerRepository) private readonly ledger: LoyaltyLedgerRepository,
  ) {}

  /** Returns the refunded order's id (for `LoyaltyOutboxConsumer` to also check referral qualification against), or `null` if the payment/order could not be resolved at all — independent of whether any point clawback actually happened. */
  async clawbackForRefund(
    refundId: string,
    paymentId: string,
    refundAmountMinor: bigint,
  ): Promise<string | null> {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return null;

    const order = await this.prisma.order.findUnique({ where: { id: payment.orderId } });
    if (!order) return null;
    if (order.payableTotalMinor <= 0n) return order.id;

    const earnEntry = await this.prisma.loyaltyLedger.findFirst({
      where: { type: 'ORDER_EARN', referenceType: 'Order', referenceId: order.id },
    });
    if (!earnEntry || earnEntry.points <= 0) return order.id; // guest order, or nothing was earned.

    const clawbackPoints = Number(
      (BigInt(earnEntry.points) * refundAmountMinor) / order.payableTotalMinor,
    );
    if (clawbackPoints <= 0) return order.id;

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.ledger.create(tx, {
          customerId: order.customerId,
          type: 'REFUND_CLAWBACK',
          points: -clawbackPoints,
          referenceType: 'Refund',
          referenceId: refundId,
          description: `Clawback for refund of order ${order.orderNumber}`,
        });
        await this.accounts.applyDelta(tx, order.customerId, { balancePoints: -clawbackPoints });
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      // already clawed back for this refund — duplicate event, no-op.
    }
    return order.id;
  }
}
