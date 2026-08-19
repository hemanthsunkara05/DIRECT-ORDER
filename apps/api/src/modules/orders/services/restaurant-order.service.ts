import { Inject, Injectable } from '@nestjs/common';
import type { OrderStatus } from '@prisma/client';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { assertTenantResourceFound } from '../../../platform/authorization/tenant-resource.js';
import { ConflictError, ValidationError } from '../../../platform/errors/app-error.js';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { PaymentRepository } from '../../payments/repositories/payment.repository.js';
import { RefundService } from '../../payments/services/refund.service.js';
import { DeliveryDispatchService } from '../../delivery/services/delivery-dispatch.service.js';
import { localMidnightToUtc, toLocalMoment } from '../../availability/timezone.js';
import {
  OrderRepository,
  type OrderWithItems,
  type OrderWithRelations,
  type RestaurantOrderFilters,
} from '../repositories/order.repository.js';
import { OrderStateService, type TransitionResult } from './order-state.service.js';

export interface OrderListPage {
  items: OrderWithItems[];
  hasMore: boolean;
}

export interface ListOrdersOptions {
  status?: OrderStatus[];
  cursor?: string;
  limit?: number;
  /**
   * Scope to the restaurant's own "today" only (docs feedback: the live
   * queue should show current/today's orders, not an ever-growing
   * unbounded list — older orders belong in the history export, not
   * here). Resolved against `RestaurantSettings.timezone`, the same
   * source `AnalyticsRollupService` already uses for day boundaries —
   * never the server's own UTC "today".
   */
  today?: boolean;
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
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async list(restaurantId: string, options: ListOrdersOptions = {}): Promise<OrderListPage> {
    const limit = Math.min(options.limit ?? 20, 100);
    const filters: RestaurantOrderFilters = { status: options.status };
    if (options.today) {
      filters.placedSince = await this.startOfRestaurantToday(restaurantId);
    }
    const rows = await this.orders.listForRestaurant(restaurantId, filters, {
      cursor: options.cursor,
      limit,
    });
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  private async startOfRestaurantToday(restaurantId: string): Promise<Date> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { timezone: true },
    });
    const timezone = restaurant?.timezone ?? 'Asia/Kolkata';
    const todayKey = toLocalMoment(new Date(), timezone).dateKey;
    return localMidnightToUtc(todayKey, timezone);
  }

  /**
   * History export (docs feedback: "month data should be stored in
   * excel kind of data") — every placed order in `[from, to)`, restaurant
   * timezone-bounded the same way the live queue's `today` scoping and
   * `AnalyticsRollupService`'s day boundaries both are. Returns rows, not
   * a formatted file — CSV serialization is the controller's concern
   * (an HTTP-response-shape detail), same division as `toPublicOrder*`
   * elsewhere in this module.
   */
  async exportOrders(
    restaurantId: string,
    fromDateKey: string,
    toDateKey: string,
  ): Promise<OrderWithItems[]> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { timezone: true },
    });
    const timezone = restaurant?.timezone ?? 'Asia/Kolkata';
    const from = localMidnightToUtc(fromDateKey, timezone);
    // Exclusive upper bound: local midnight of the day AFTER `toDateKey`,
    // so a caller requesting "2026-08-01 to 2026-08-31" gets the whole
    // of the 31st, not everything up to its own midnight.
    const [y, m, d] = toDateKey.split('-').map(Number);
    const nextDay = new Date(Date.UTC(y!, m! - 1, d));
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const toExclusive = localMidnightToUtc(
      `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDay.getUTCDate()).padStart(2, '0')}`,
      timezone,
    );
    if (from >= toExclusive) {
      throw new ValidationError('`from` must be on or before `to`.');
    }
    return this.orders.listForRestaurantExport(restaurantId, { from, to: toExclusive });
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

  /**
   * Restaurant-initiated cancellation-after-accept (docs/06 BR-174) —
   * mirrors `reject()`'s refund-on-applied pattern and
   * `AdminOrderService.cancel()`'s identical transition exactly, just
   * attributed `RESTAURANT_USER` instead of `ADMIN`. Deliberately
   * NARROWER than `OrderStateService`'s own transition graph, which also
   * allows PLACED → CANCELLED (kept there for other callers, e.g. an
   * admin cancelling on a customer's behalf before the restaurant has
   * responded at all) — a restaurant abandoning an unaccepted order has
   * `reject()` for that, with its own distinct customer-facing "rejected"
   * messaging.
   *
   * Only PLACED is explicitly blocked here, pre-transition — every other
   * status (including an ALREADY-cancelled order) falls through to
   * `orderState.transition()` unchecked, so its own idempotent-replay
   * and graph-validation logic still applies unmodified. Blocking on a
   * broader whitelist instead (found live, via this method's own
   * concurrency test): two concurrent cancel calls both read the
   * pre-transition status via `detail()` before either has committed, so
   * whichever loses the race can just as easily see the WINNER's
   * already-applied CANCELLED status by the time it checks — a whitelist
   * that didn't also accept CANCELLED rejected that idempotent replay
   * with a spurious 409 instead of `transition()`'s normal
   * `applied:false, 200`.
   */
  async cancel(
    restaurantId: string,
    orderId: string,
    actorId: string,
    reason: string,
  ): Promise<TransitionResult> {
    const order = await this.detail(restaurantId, orderId, actorId);
    if (order.status === 'PLACED') {
      throw new ConflictError(
        `Order ${orderId} has not been accepted yet — use reject(), not cancel(), for a PLACED order.`,
        [{ field: 'status', message: `Current state is ${order.status}.` }],
      );
    }

    const result = await this.orderState.transition(
      orderId,
      'CANCELLED',
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
            reason: `Order cancelled by restaurant: ${reason}`,
            initiatedByActorType: 'RESTAURANT_USER',
            initiatedByActorId: actorId,
            idempotencyKey: `order:${orderId}:restaurant-cancellation-refund`,
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
