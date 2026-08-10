import { Inject, Injectable } from '@nestjs/common';
import type { Payment } from '@prisma/client';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';
import { NotFoundError, AppError } from '../../../platform/errors/app-error.js';
import { OrderStateService } from '../../orders/services/order-state.service.js';
import { OrderRepository } from '../../orders/repositories/order.repository.js';
import { PaymentRepository } from '../repositories/payment.repository.js';
import { ReconciliationService } from './reconciliation.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderPaymentStatus,
} from '../providers/payment-provider.port.js';

export interface VerificationResult {
  payment: Payment;
  orderStatus: string;
}

/** CAPTURED and FAILED are both "resolved" outcomes of a single attempt — same rank, mutually exclusive, neither regresses into the other or into an earlier stage. */
const STATUS_RANK: Record<Payment['status'], number> = {
  CREATED: 0,
  PENDING: 1,
  AUTHORIZED: 2,
  CAPTURED: 3,
  FAILED: 3,
  CANCELLED: 3,
  PARTIALLY_REFUNDED: 4,
  REFUNDED: 5,
};

/**
 * The one place a provider-reported payment status is applied to our
 * Payment + Order rows (docs/03-state-machines.md §7.2: "Only the
 * payments module writes payment state, only in response to a verified
 * provider signal"). Both real entry points converge here:
 * `verify()` (the `/public/orders/:orderNumber/verify-payment` endpoint
 * — "never trusts client status; fetches from provider") and
 * WebhookService (after signature verification) — so a webhook and a
 * frontend-triggered verification poll can never disagree about how a
 * given provider status gets applied.
 */
@Injectable()
export class PaymentVerificationService {
  constructor(
    @Inject(PaymentRepository) private readonly payments: PaymentRepository,
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(OrderStateService) private readonly orderState: OrderStateService,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * `providerPaymentIdHint` is what a real Razorpay Checkout.js success
   * callback hands the frontend (`razorpay_payment_id`) — used only to
   * know WHICH provider payment to fetch; the returned status is what
   * gets applied, never the hint itself (BR-37).
   */
  async verify(orderNumber: string, providerPaymentIdHint?: string): Promise<VerificationResult> {
    const order = await this.orders.findByOrderNumber(orderNumber);
    if (!order) {
      throw new NotFoundError('Order not found.');
    }

    const payment = order.payments[0];
    if (!payment) {
      throw new AppError('PAYMENT_NOT_FOUND', 409, 'This order has no payment attempt to verify.');
    }

    const providerPaymentId = payment.providerPaymentId ?? providerPaymentIdHint;
    if (!providerPaymentId) {
      // Nothing to fetch yet — the customer hasn't completed the
      // provider's checkout step. Not an error: the frontend polls this
      // endpoint, and "still pending" is an expected, valid state.
      return { payment, orderStatus: order.status };
    }

    const status = await this.paymentProvider.fetchPaymentStatus(providerPaymentId);
    const applied = await this.applyProviderStatus(payment, status);
    return applied;
  }

  async applyProviderStatus(
    payment: Payment,
    status: ProviderPaymentStatus,
  ): Promise<VerificationResult> {
    const current = await this.payments.findByIdForUpdate(payment.id);
    if (!current) {
      throw new NotFoundError('Payment not found.');
    }

    const targetStatus = status.status; // 'CREATED' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED'
    if (STATUS_RANK[current.status] >= 3 && STATUS_RANK[targetStatus] <= 3) {
      // Already resolved (CAPTURED/FAILED/CANCELLED or further into
      // refunds) — never regress (docs/03 §7.2 "Monotonicity"). A
      // conflicting terminal report (e.g. FAILED reported after we
      // already recorded CAPTURED) is surfaced for review rather than
      // silently dropped or blindly re-applied.
      if (
        current.status !== targetStatus &&
        (current.status === 'CAPTURED' || current.status === 'FAILED')
      ) {
        await this.reconciliation.raiseStatusConflict(current, targetStatus);
      }
      this.logger.warn(
        { paymentId: current.id, currentStatus: current.status, reportedStatus: targetStatus },
        'Ignored out-of-order/stale provider payment status',
      );
      const order = await this.orders.findById(current.orderId);
      return { payment: current, orderStatus: order?.status ?? 'PENDING_PAYMENT' };
    }

    if (targetStatus === 'CAPTURED') {
      if (status.amountMinor !== current.amountMinor || status.currency !== current.currency) {
        await this.payments.update(current.id, { reconciliationStatus: 'AMOUNT_MISMATCH' });
        await this.reconciliation.raiseAmountMismatch(current, status.amountMinor, status.currency);
        // Order stays PENDING_PAYMENT — never mark CAPTURED on a mismatch.
        const order = await this.orders.findById(current.orderId);
        return { payment: current, orderStatus: order?.status ?? 'PENDING_PAYMENT' };
      }

      const updated = await this.payments.update(current.id, {
        status: 'CAPTURED',
        providerPaymentId: status.providerPaymentId,
        capturedMinor: status.amountMinor,
        method: status.method,
        capturedAt: new Date(),
        authorizedAt: current.authorizedAt ?? new Date(),
      });
      const { order } = await this.orderState.transition(current.orderId, 'PLACED', {
        type: 'SYSTEM',
      });
      return { payment: updated, orderStatus: order.status };
    }

    if (targetStatus === 'FAILED') {
      const updated = await this.payments.update(current.id, {
        status: 'FAILED',
        failureCode: status.failureCode ?? null,
        failureMessage: status.failureMessage ?? null,
      });
      const { order } = await this.orderState.transition(current.orderId, 'PAYMENT_FAILED', {
        type: 'SYSTEM',
      });
      return { payment: updated, orderStatus: order.status };
    }

    if (targetStatus === 'AUTHORIZED') {
      const updated = await this.payments.update(current.id, {
        status: 'AUTHORIZED',
        authorizedAt: new Date(),
      });
      const order = await this.orders.findById(current.orderId);
      return { payment: updated, orderStatus: order?.status ?? 'PENDING_PAYMENT' };
    }

    // CREATED — no change.
    const order = await this.orders.findById(current.orderId);
    return { payment: current, orderStatus: order?.status ?? 'PENDING_PAYMENT' };
  }
}
