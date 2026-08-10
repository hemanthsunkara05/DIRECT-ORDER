import { Inject, Injectable } from '@nestjs/common';
import type { Payment } from '@prisma/client';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';
import { ReconciliationIssueRepository } from '../repositories/reconciliation-issue.repository.js';

/**
 * docs/03-state-machines.md §7.2: "If provider amount ≠
 * order.payable_total_minor, do NOT mark CAPTURED. Set
 * reconciliation_status = 'AMOUNT_MISMATCH', raise a CRITICAL
 * ReconciliationIssue, alert." A mismatch is recorded and surfaced,
 * never silently corrected or auto-resolved — resolution is a manual
 * admin action (Phase 10+'s admin module; `ReconciliationIssueRepository`
 * already exposes `listOpen()` for it).
 */
@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(ReconciliationIssueRepository) private readonly issues: ReconciliationIssueRepository,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  async raiseAmountMismatch(
    payment: Payment,
    providerAmountMinor: bigint,
    providerCurrency: string,
  ): Promise<void> {
    await this.issues.create({
      entityType: 'Payment',
      entityId: payment.id,
      issueType: 'AMOUNT_MISMATCH',
      expected: `${payment.amountMinor} ${payment.currency}`,
      actual: `${providerAmountMinor} ${providerCurrency}`,
      severity: 'CRITICAL',
    });
    this.logger.error(
      {
        paymentId: payment.id,
        orderId: payment.orderId,
        expectedAmountMinor: payment.amountMinor.toString(),
        expectedCurrency: payment.currency,
        actualAmountMinor: providerAmountMinor.toString(),
        actualCurrency: providerCurrency,
      },
      'Payment amount/currency mismatch — provider confirmation withheld, CRITICAL reconciliation issue raised',
    );
  }

  /** A provider reports a terminal status that conflicts with one we already recorded (e.g. FAILED after CAPTURED) — surfaced for manual review, never silently applied (docs/03 §7.2's monotonicity rule). */
  async raiseStatusConflict(payment: Payment, reportedStatus: string): Promise<void> {
    await this.issues.create({
      entityType: 'Payment',
      entityId: payment.id,
      issueType: 'STATUS_CONFLICT',
      expected: payment.status,
      actual: reportedStatus,
      severity: 'HIGH',
    });
    this.logger.error(
      {
        paymentId: payment.id,
        orderId: payment.orderId,
        currentStatus: payment.status,
        reportedStatus,
      },
      'Conflicting terminal payment status reported — HIGH reconciliation issue raised',
    );
  }
}
