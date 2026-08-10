import { Inject, Injectable } from '@nestjs/common';
import type { Order, OrderItem, OrderStatus, OrderStatusHistory, Payment } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export type OrderWithRelations = Order & {
  items: OrderItem[];
  history: OrderStatusHistory[];
  payments: Payment[];
};

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
 */
@Injectable()
export class OrderRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

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
}
