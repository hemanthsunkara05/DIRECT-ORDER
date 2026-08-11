import { Inject, Injectable } from '@nestjs/common';
import type { Refund } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { ConflictError, NotFoundError } from '../../../platform/errors/app-error.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';
import { PaymentRepository } from '../repositories/payment.repository.js';
import { RefundRepository } from '../repositories/refund.repository.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../providers/payment-provider.port.js';

export interface RequestRefundInput {
  paymentId: string;
  amountMinor: bigint;
  reason: string;
  initiatedByActorType: string;
  initiatedByActorId?: string;
  idempotencyKey: string;
}

/**
 * Refund creation (docs/03-state-machines.md §7.3: "Creation guard
 * (inside one transaction): lock the payment row → sum non-FAILED
 * refunds → reject if sum + new > captured_minor → insert. This is what
 * makes INV-6 hold under concurrency"). No HTTP endpoint calls this yet
 * — the two real triggers (automatic full refund on restaurant
 * rejection, and admin-initiated manual/goodwill refunds) both need
 * actors and modules that don't exist until Phase 10's restaurant order
 * management and a future Admin module. Built and unit-tested complete
 * now, same "one service per aggregate, wired to HTTP later" treatment
 * already applied to OrderStateService's restaurant-driven transitions.
 */
@Injectable()
export class RefundService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PaymentRepository) private readonly payments: PaymentRepository,
    @Inject(RefundRepository) private readonly refunds: RefundRepository,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
  ) {}

  async requestRefund(input: RequestRefundInput): Promise<Refund> {
    const existingIdempotent = await this.refunds.findByPaymentAndIdempotencyKey(
      input.paymentId,
      input.idempotencyKey,
    );
    if (existingIdempotent) {
      return existingIdempotent;
    }

    const refund = await this.prisma.$transaction(async (tx) => {
      // Real Postgres: `SELECT ... FOR UPDATE` — see
      // PaymentRepository.findByIdForUpdate's doc comment for this
      // sandbox's standing in-memory-fake degradation.
      const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
      if (!payment) {
        throw new NotFoundError('Payment not found.');
      }
      if (payment.status !== 'CAPTURED' && payment.status !== 'PARTIALLY_REFUNDED') {
        throw new ConflictError(`Cannot refund a payment in status ${payment.status}.`, [
          { field: 'status', message: payment.status },
        ]);
      }

      const active = await tx.refund.findMany({
        where: { paymentId: input.paymentId, status: { not: 'FAILED' } },
      });
      const alreadyRefunded = active.reduce((sum, r) => sum + r.amountMinor, 0n);

      if (alreadyRefunded + input.amountMinor > payment.capturedMinor) {
        throw new ConflictError('Refund amount would exceed the captured amount.', [
          {
            field: 'amountMinor',
            message: `capturedMinor=${payment.capturedMinor}, alreadyRefunded=${alreadyRefunded}, requested=${input.amountMinor}`,
          },
        ]);
      }

      return tx.refund.create({
        data: {
          paymentId: payment.id,
          orderId: payment.orderId,
          amountMinor: input.amountMinor,
          reason: input.reason,
          status: 'REQUESTED',
          initiatedByActorType: input.initiatedByActorType,
          initiatedByActorId: input.initiatedByActorId,
          idempotencyKey: input.idempotencyKey,
        },
      });
    });

    // Universal rule 4 (docs/03 §7): emitted after commit, never inside
    // the transaction. Phase 12's notification catalogue maps this to
    // REFUND_INITIATED (docs/07-events-and-jobs.md §11.2) — added in
    // that phase; this call site previously only emitted on completion.
    await this.outbox.record('REFUND_INITIATED', {
      refundId: refund.id,
      paymentId: refund.paymentId,
      orderId: refund.orderId,
      amountMinor: refund.amountMinor.toString(),
    });

    // Provider call outside the transaction — never hold a DB
    // transaction open across network I/O.
    await this.submitToProvider(refund);
    return (await this.refunds.findByPaymentAndIdempotencyKey(
      input.paymentId,
      input.idempotencyKey,
    ))!;
  }

  private async submitToProvider(refund: Refund): Promise<void> {
    const payment = await this.payments.findById(refund.paymentId);
    if (!payment?.providerPaymentId) {
      await this.refunds.update(refund.id, {
        status: 'FAILED',
        failureReason: 'Payment has no provider payment id to refund against.',
      });
      return;
    }

    await this.refunds.update(refund.id, { status: 'PROCESSING' });

    const result = await this.paymentProvider.createRefund({
      providerPaymentId: payment.providerPaymentId,
      amountMinor: refund.amountMinor,
      idempotencyKey: refund.idempotencyKey,
    });

    if (result.status === 'COMPLETED') {
      await this.markCompleted(
        refund.id,
        refund.paymentId,
        refund.amountMinor,
        result.providerRefundId,
      );
    } else if (result.status === 'FAILED') {
      await this.refunds.update(refund.id, {
        status: 'FAILED',
        providerRefundId: result.providerRefundId,
        failureReason: 'Provider reported refund failure.',
      });
    } else {
      await this.refunds.update(refund.id, {
        status: 'PROCESSING',
        providerRefundId: result.providerRefundId,
      });
    }
  }

  /** Locks the payment row again to update `refundedMinor`/`status` — a second, independent guarded write, not reused from the creation transaction (that one only reserved the amount; this one confirms it actually happened). */
  private async markCompleted(
    refundId: string,
    paymentId: string,
    amountMinor: bigint,
    providerRefundId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return;

      const newRefundedMinor = payment.refundedMinor + amountMinor;
      const newStatus =
        newRefundedMinor >= payment.capturedMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

      await tx.payment.update({
        where: { id: paymentId },
        data: { refundedMinor: newRefundedMinor, status: newStatus },
      });
      await tx.refund.update({
        where: { id: refundId },
        data: { status: 'COMPLETED', providerRefundId, completedAt: new Date() },
      });
    });

    await this.outbox.record('REFUND_COMPLETED', {
      refundId,
      paymentId,
      amountMinor: amountMinor.toString(),
    });
  }
}
