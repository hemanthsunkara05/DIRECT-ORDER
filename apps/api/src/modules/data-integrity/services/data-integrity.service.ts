import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { ReconciliationIssueRepository } from '../../payments/repositories/reconciliation-issue.repository.js';
import { LoyaltyReconciliationService } from '../../loyalty/services/loyalty-reconciliation.service.js';

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

const NOT_YET_PAID_STATUSES: OrderStatus[] = ['PENDING_PAYMENT', 'PAYMENT_FAILED', 'EXPIRED'];

export interface AssertionResult {
  assertion: string;
  violations: number;
}

/**
 * docs/11-testing-strategy.md §18.6, "data integrity assertions": six
 * named, read-only checks run "after the full suite and on a schedule
 * in production." Every violation is recorded the same way every
 * other reconciliation mismatch in this codebase already is —
 * `ReconciliationIssueRepository.create` — so `GET
 * /admin/reconciliation-issues` (Phase 13) already surfaces these
 * without a new endpoint. Every check reads the money/count columns
 * it needs and computes in JS (BigInt arithmetic / Map-based
 * counting), never a raw SQL string — the same style this codebase's
 * other invariant checks already use (`RefundService`,
 * `AnalyticsRollupService.aggregateOrders`), and it means the exact
 * same code runs identically against the in-memory test fake and real
 * Postgres, no per-database-engine SQL dialect to keep in sync.
 *
 * Same lightweight self-starting in-process poller shape as every
 * other scheduler in this codebase — daily, matching docs/11's own
 * cadence language, not a real cron/queue job.
 */
@Injectable()
export class DataIntegrityService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReconciliationIssueRepository) private readonly issues: ReconciliationIssueRepository,
    @Inject(LoyaltyReconciliationService)
    private readonly loyaltyReconciliation: LoyaltyReconciliationService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.runAll().catch(() => {
        /* best-effort background job — a failed pass is not a request-path error. */
      });
    }, DAILY_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs every assertion and returns each one's violation count — used directly by tests, not just the timer above. */
  async runAll(): Promise<AssertionResult[]> {
    const [
      orderTotalIdentity,
      noOverRefund,
      noDuplicateDeliveryPerOrder,
      loyaltyBalanceMatchesLedger,
      noOrderPlacedWithoutCapturedPayment,
      noReferralRewardedTwice,
    ] = await Promise.all([
      this.checkOrderTotalIdentity(),
      this.checkNoOverRefund(),
      this.checkNoDuplicateDeliveryPerOrder(),
      this.loyaltyReconciliation.reconcile(),
      this.checkNoOrderPlacedWithoutCapturedPayment(),
      this.checkNoReferralRewardedTwice(),
    ]);

    return [
      { assertion: 'ORDER_TOTAL_IDENTITY', violations: orderTotalIdentity },
      { assertion: 'NO_OVER_REFUND', violations: noOverRefund },
      { assertion: 'NO_DUPLICATE_DELIVERY_PER_ORDER', violations: noDuplicateDeliveryPerOrder },
      { assertion: 'LOYALTY_BALANCE_MATCHES_LEDGER', violations: loyaltyBalanceMatchesLedger },
      {
        assertion: 'NO_ORDER_PLACED_WITHOUT_CAPTURED_PAYMENT',
        violations: noOrderPlacedWithoutCapturedPayment,
      },
      { assertion: 'NO_REFERRAL_REWARDED_TWICE', violations: noReferralRewardedTwice },
    ];
  }

  /**
   * "No order violates its total identity." `Order.discountMinor` is
   * ALREADY `promotionDiscountMinor + loyaltyDiscountMinor` by the time
   * checkout persists it (`packages/money/src/pricing.ts`'s
   * `PricingBreakdown.discountMinor` doc comment: "already capped —
   * BR-7"; `checkout.service.ts` copies `quote.breakdown.discountMinor`
   * straight onto the order). `Order.loyaltyDiscountMinor` is an
   * informational breakdown of how much of that combined total came
   * from loyalty, not a second amount to subtract again — subtracting
   * both here double-counts the loyalty portion (found live against
   * real dev data: a real order with a 500-minor loyalty redemption and
   * no promotion falsely flagged as a 500-minor mismatch).
   */
  private async checkOrderTotalIdentity(): Promise<number> {
    const orders = await this.prisma.order.findMany({
      select: {
        id: true,
        payableTotalMinor: true,
        itemsSubtotalMinor: true,
        packagingFeeMinor: true,
        deliveryFeeMinor: true,
        platformFeeMinor: true,
        taxMinor: true,
        discountMinor: true,
      },
    });

    let violations = 0;
    for (const order of orders) {
      const expected =
        order.itemsSubtotalMinor +
        order.packagingFeeMinor +
        order.deliveryFeeMinor +
        order.platformFeeMinor +
        order.taxMinor -
        order.discountMinor;
      if (order.payableTotalMinor !== expected) {
        violations++;
        await this.issues.create({
          entityType: 'Order',
          entityId: order.id,
          issueType: 'ORDER_TOTAL_IDENTITY_VIOLATION',
          expected: String(expected),
          actual: String(order.payableTotalMinor),
          severity: 'CRITICAL',
        });
      }
    }
    return violations;
  }

  /** "No over-refund." */
  private async checkNoOverRefund(): Promise<number> {
    const payments = await this.prisma.payment.findMany({
      select: { id: true, capturedMinor: true, refundedMinor: true },
    });

    let violations = 0;
    for (const payment of payments) {
      if (payment.refundedMinor > payment.capturedMinor) {
        violations++;
        await this.issues.create({
          entityType: 'Payment',
          entityId: payment.id,
          issueType: 'OVER_REFUND',
          expected: `<= ${payment.capturedMinor}`,
          actual: String(payment.refundedMinor),
          severity: 'CRITICAL',
        });
      }
    }
    return violations;
  }

  /**
   * "No duplicate delivery per order." `Delivery.@@unique([orderId])`
   * already makes this structurally impossible at the database level
   * — this check exists to actually PROVE that constraint is doing
   * its job, not because a violation is expected in practice.
   */
  private async checkNoDuplicateDeliveryPerOrder(): Promise<number> {
    const deliveries = await this.prisma.delivery.findMany({ select: { orderId: true } });
    const countsByOrder = new Map<string, number>();
    for (const delivery of deliveries) {
      countsByOrder.set(delivery.orderId, (countsByOrder.get(delivery.orderId) ?? 0) + 1);
    }

    let violations = 0;
    for (const [orderId, count] of countsByOrder) {
      if (count > 1) {
        violations++;
        await this.issues.create({
          entityType: 'Order',
          entityId: orderId,
          issueType: 'DUPLICATE_DELIVERY_PER_ORDER',
          expected: '1',
          actual: String(count),
          severity: 'HIGH',
        });
      }
    }
    return violations;
  }

  /** "No order paid without a captured payment" — an order past PENDING_PAYMENT/PAYMENT_FAILED/EXPIRED must have at least one payment with a real captured amount. */
  private async checkNoOrderPlacedWithoutCapturedPayment(): Promise<number> {
    const orders = await this.prisma.order.findMany({
      where: { status: { notIn: [...NOT_YET_PAID_STATUSES] } },
      select: { id: true },
    });
    if (orders.length === 0) return 0;

    const orderIds = orders.map((o) => o.id);
    const payments = await this.prisma.payment.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true, capturedMinor: true },
    });
    const capturedByOrder = new Map<string, bigint>();
    for (const payment of payments) {
      capturedByOrder.set(
        payment.orderId,
        (capturedByOrder.get(payment.orderId) ?? 0n) + payment.capturedMinor,
      );
    }

    let violations = 0;
    for (const order of orders) {
      const captured = capturedByOrder.get(order.id) ?? 0n;
      if (captured <= 0n) {
        violations++;
        await this.issues.create({
          entityType: 'Order',
          entityId: order.id,
          issueType: 'ORDER_PLACED_WITHOUT_CAPTURED_PAYMENT',
          expected: '> 0',
          actual: String(captured),
          severity: 'CRITICAL',
        });
      }
    }
    return violations;
  }

  /**
   * "No referral rewarded twice." `LoyaltyLedger`'s own hand-written
   * partial unique index (`(type, referenceType, referenceId) WHERE
   * referenceId IS NOT NULL AND type <> 'ADMIN_ADJUSTMENT'`) already
   * makes this structurally impossible — same "prove the constraint
   * works" reasoning as the duplicate-delivery check above.
   */
  private async checkNoReferralRewardedTwice(): Promise<number> {
    const rewards = await this.prisma.loyaltyLedger.findMany({
      where: { type: 'REFERRAL_REWARD' },
      select: { referenceId: true },
    });
    const countsByReference = new Map<string, number>();
    for (const reward of rewards) {
      if (!reward.referenceId) continue;
      countsByReference.set(reward.referenceId, (countsByReference.get(reward.referenceId) ?? 0) + 1);
    }

    let violations = 0;
    for (const [referenceId, count] of countsByReference) {
      if (count > 1) {
        violations++;
        await this.issues.create({
          entityType: 'Referral',
          entityId: referenceId,
          issueType: 'REFERRAL_REWARDED_TWICE',
          expected: '1',
          actual: String(count),
          severity: 'HIGH',
        });
      }
    }
    return violations;
  }
}
