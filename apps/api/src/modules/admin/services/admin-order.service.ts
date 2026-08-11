import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../platform/errors/app-error.js';
import {
  OrderStateService,
  type TransitionResult,
} from '../../orders/services/order-state.service.js';
import { PaymentRepository } from '../../payments/repositories/payment.repository.js';
import { RefundService } from '../../payments/services/refund.service.js';
import { AdminQueryRepository } from '../repositories/admin-query.repository.js';

/**
 * `POST /admin/orders/:id/cancel` (docs/04 §8.7: "Reason required; goes
 * through the state machine"). Mirrors `RestaurantOrderService.reject()`
 * exactly — same refund-on-cancellation trigger, gated on
 * `result.applied` for the same structural-exactly-once reason (see
 * that service's own doc comment) — docs/07-events-and-jobs.md §11.2's
 * event catalogue lists `ORDER_CANCELLED → payments(refund)` alongside
 * `ORDER_REJECTED`'s identical refund consumer.
 *
 * `OrderStateService`'s own transition graph is what actually makes
 * "DELIVERED cannot be moved to PREPARING" true (docs/14-acceptance-
 * criteria.md, Phase 13) — `DELIVERED` has no outgoing edges at all
 * (`ORDER_TRANSITIONS.DELIVERED = []`), so ANY target from there,
 * including a cancel, is already a structural 409. Nothing new needed
 * here to satisfy that criterion; a test proves it directly for this
 * phase regardless.
 */
@Injectable()
export class AdminOrderService {
  constructor(
    @Inject(AdminQueryRepository) private readonly admin: AdminQueryRepository,
    @Inject(OrderStateService) private readonly orderState: OrderStateService,
    @Inject(PaymentRepository) private readonly payments: PaymentRepository,
    @Inject(RefundService) private readonly refunds: RefundService,
  ) {}

  async cancel(orderId: string, adminUserId: string, reason: string): Promise<TransitionResult> {
    const order = await this.admin.findOrderById(orderId);
    if (!order) {
      throw new NotFoundError('Order not found.');
    }

    const result = await this.orderState.transition(
      orderId,
      'CANCELLED',
      { type: 'ADMIN', id: adminUserId },
      { reason },
    );

    if (result.applied) {
      const payments = await this.payments.findByOrderId(orderId);
      const refundable = payments.find(
        (p) => p.status === 'CAPTURED' || p.status === 'PARTIALLY_REFUNDED',
      );
      if (refundable) {
        const remaining = refundable.capturedMinor - refundable.refundedMinor;
        if (remaining > 0n) {
          await this.refunds.requestRefund({
            paymentId: refundable.id,
            amountMinor: remaining,
            reason: `Order cancelled by admin: ${reason}`,
            initiatedByActorType: 'ADMIN',
            initiatedByActorId: adminUserId,
            idempotencyKey: `order:${orderId}:admin-cancellation-refund`,
          });
        }
      }
    }

    return result;
  }
}
