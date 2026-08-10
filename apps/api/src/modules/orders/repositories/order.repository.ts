import { Inject, Injectable } from '@nestjs/common';
import type {
  Delivery,
  Order,
  OrderItem,
  OrderStatus,
  OrderStatusHistory,
  Payment,
} from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export type OrderWithRelations = Order & {
  items: OrderItem[];
  history: OrderStatusHistory[];
  payments: Payment[];
  /** Phase 11 — null until the restaurant marks the order ready and dispatch runs. */
  delivery: Delivery | null;
};

export interface RestaurantOrderFilters {
  status?: OrderStatus[];
}

export interface ListForRestaurantOptions {
  cursor?: string;
  limit?: number;
}

/**
 * Reads and the locked-transition write path only. Order *creation* is
 * owned by CheckoutService, not this repository — it is one atomic
 * write spanning Customer, Order, OrderItem, Payment, OrderStatusHistory
 * and a Cart status update, none of which nest cleanly under a single
 * Prisma relation `create`, so CheckoutService issues it directly via
 * `PrismaService.$transaction` (the same "service owns its own
 * transaction" shape MenuItemService.reorder already established) —
 * see docs/12-repository-structure.md §19 for why that beats inventing
 * a transaction-aware repository abstraction this is the only caller of.
 *
 * Extends `TenantScopedRepository` (Phase 10) for the two new
 * restaurant-facing methods below — every earlier method here stays
 * deliberately unscoped: `findById`/`findByIdForUpdate`/
 * `findPendingPaymentOlderThan`/etc. are called from system contexts
 * with no authenticated tenant at all (webhook processing, the expiry
 * scheduler, order tracking by guest token), so scoping them would be
 * wrong, not just redundant.
 */
@Injectable()
export class OrderRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async findById(orderId: string): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { id: orderId } });
  }

  /**
   * Real Postgres would `SELECT ... FOR UPDATE` here (docs/03-state-
   * machines.md universal rule 2); same documented, in-memory-fake-only
   * degradation as PaymentRepository.findByIdForUpdate — see this
   * phase's report for what remains unverified without Docker.
   */
  async findByIdForUpdate(orderId: string): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { id: orderId } });
  }

  async findByOrderNumber(orderNumber: string): Promise<OrderWithRelations | null> {
    return this.prisma.order.findUnique({
      where: { orderNumber },
      include: {
        items: true,
        history: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' } },
        delivery: true,
      },
    });
  }

  async findByRestaurantIdempotencyKey(
    restaurantId: string,
    idempotencyKey: string,
  ): Promise<Order | null> {
    return this.prisma.order.findUnique({
      where: { restaurantId_idempotencyKey: { restaurantId, idempotencyKey } },
    });
  }

  /** BR-30-style unpaid-order expiry scan: PENDING_PAYMENT rows older than `ORDER_PAYMENT_TTL_MINUTES`. */
  async findPendingPaymentOlderThan(cutoff: Date): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { status: 'PENDING_PAYMENT', createdAt: { lt: cutoff } },
    });
  }

  async appendStatusHistory(
    orderId: string,
    fromStatus: OrderStatus | null,
    toStatus: OrderStatus,
    actorType: string,
    actorId?: string,
    reason?: string,
  ): Promise<void> {
    await this.prisma.orderStatusHistory.create({
      data: { orderId, fromStatus, toStatus, actorType, actorId, reason },
    });
  }

  /**
   * The order queue (`GET /restaurant/orders`, docs/04 §8.5) — cursor
   * pagination by `id` (UUIDv7, time-ordered), same convention
   * AuditService's pagination already established. Callers request
   * `limit + 1` rows and treat the extra row's presence as `hasMore`
   * (RestaurantOrderService does this, never this method) rather than
   * returning it.
   */
  async listForRestaurant(
    restaurantId: string,
    filters: RestaurantOrderFilters,
    options: ListForRestaurantOptions = {},
  ): Promise<Order[]> {
    const limit = Math.min(options.limit ?? 20, 100);
    return this.prisma.order.findMany({
      where: this.withTenant(
        restaurantId,
        filters.status?.length ? { status: { in: filters.status } } : {},
      ),
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
  }

  /** Order detail (`GET /restaurant/orders/:id`) — `findFirst`, not `findUnique`: `{id, restaurantId}` isn't a declared unique constraint, only `id` alone is. */
  async findByIdForRestaurant(
    restaurantId: string,
    orderId: string,
  ): Promise<OrderWithRelations | null> {
    return this.prisma.order.findFirst({
      where: this.withTenant(restaurantId, { id: orderId }),
      include: {
        items: true,
        history: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' } },
        delivery: true,
      },
    });
  }
}
