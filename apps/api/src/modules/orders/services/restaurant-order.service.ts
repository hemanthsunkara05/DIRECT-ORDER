import { Inject, Injectable } from '@nestjs/common';
import type { Order, OrderStatus } from '@prisma/client';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { assertTenantResourceFound } from '../../../platform/authorization/tenant-resource.js';
import { PaymentRepository } from '../../payments/repositories/payment.repository.js';
import { RefundService } from '../../payments/services/refund.service.js';
import { DeliveryDispatchService } from '../../delivery/services/delivery-dispatch.service.js';
import {
  OrderRepository,
  type OrderWithRelations,
  type RestaurantOrderFilters,
} from '../repositories/order.repository.js';
import { OrderStateService, type TransitionResult } from './order-state.service.js';

export interface OrderListPage {
  items: Order[];
  hasMore: boolean;
}

export interface ListOrdersOptions {
  status?: OrderStatus[];
  cursor?: string;
  limit?: number;
}

/**
 * `/restaurant/orders*` (docs/04-api-specification.md §8.5). Owns
 * tenant-ownership checks (via `assertTenantResourceFound` — the same
 * 404-not-403 pattern every other tenant-scoped domain uses) and the
 * one piece of orchestration genuinely new this phase: triggering a
 * refund on rejection. Everything else — graph legality, locking,
 * idempotent replay, the outbox event — is `OrderStateService`'s job,
 * reused as-is; this service adds nothing to that path except the
 * pre-check.
 */
@Injectable()
export class RestaurantOrderService {
  constructor(
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(OrderStateService) private readonly orderState: OrderStateService,
    @Inject(PaymentRepository) private readonly payments: PaymentRepository,
    @Inject(RefundService) private readonly refunds: RefundService,
    @Inject(DeliveryDispatchService) private readonly deliveryDispatch: DeliveryDispatchService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(restaurantId: string, options: ListOrdersOptions = {}): Promise<OrderListPage> {
    const limit = Math.min(options.limit ?? 20, 100);
    const filters: RestaurantOrderFilters = { status: options.status };
    const rows = await this.orders.listForRestaurant(restaurantId, filters, {
      cursor: options.cursor,
      limit,
    });
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  async detail(
    restaurantId: string,
    orderId: string,
    actorId: string,
  ): Promise<OrderWithRelations> {
    const order = await this.orders.findByIdForRestaurant(restaurantId, orderId);
    return assertTenantResourceFound(order, {
      audit: this.audit,
      actorId,
      restaurantId,
      entityType: 'Order',
      entityId: orderId,
    });
  }

  async accept(restaurantId: string, orderId: string, actorId: string): Promise<TransitionResult> {
    await this.detail(restaurantId, orderId, actorId);
    return this.orderState.transition(orderId, 'ACCEPTED', {
      type: 'RESTAURANT_USER',
      id: actorId,
    });
  }

  /**
   * docs/03-state-machines.md §7.1: PLACED → REJECTED "Trigger full
   * refund". Refund is only ever attempted when THIS call is the one
   * that actually applied the transition (`result.applied`) — under a
   * true concurrent double-rejection, `OrderStateService.transition`'s
   * own locked idempotent-replay guarantees exactly one caller ever
   * sees `applied: true` (docs/03 §7's "Concurrency" note: "Exactly one
   * refund can ever be triggered"), so this is structural, not an extra
   * guard bolted on here. The refund's own idempotency key is derived
   * from the order id, not client-supplied — rejection is a single,
   * deterministic event, not a retryable client action.
   */
  async reject(
    restaurantId: string,
    orderId: string,
    actorId: string,
    reason: string,
  ): Promise<TransitionResult> {
    await this.detail(restaurantId, orderId, actorId);
    const result = await this.orderState.transition(
      orderId,
      'REJECTED',
      { type: 'RESTAURANT_USER', id: actorId },
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
            reason: `Order rejected by restaurant: ${reason}`,
            initiatedByActorType: 'RESTAURANT_USER',
            initiatedByActorId: actorId,
            idempotencyKey: `order:${orderId}:rejection-refund`,
          });
        }
      }
    }

    return result;
  }

  async preparing(
    restaurantId: string,
    orderId: string,
    actorId: string,
  ): Promise<TransitionResult> {
    await this.detail(restaurantId, orderId, actorId);
    return this.orderState.transition(orderId, 'PREPARING', {
      type: 'RESTAURANT_USER',
      id: actorId,
    });
  }

  /**
   * docs/14-acceptance-criteria.md: "Marking ready dispatches exactly
   * one delivery." Dispatch is only ever attempted when THIS call is
   * the one that actually applied the transition (`result.applied`) —
   * same structural-exactly-once reasoning as `reject()`'s refund call
   * above, and the real backstop either way is
   * `DeliveryRepository.createIfNotExists`'s `@@unique([orderId])`, not
   * this check.
   */
  async ready(restaurantId: string, orderId: string, actorId: string): Promise<TransitionResult> {
    await this.detail(restaurantId, orderId, actorId);
    const result = await this.orderState.transition(orderId, 'READY_FOR_PICKUP', {
      type: 'RESTAURANT_USER',
      id: actorId,
    });

    if (result.applied) {
      await this.deliveryDispatch.dispatch(result.order);
    }

    return result;
  }
}
