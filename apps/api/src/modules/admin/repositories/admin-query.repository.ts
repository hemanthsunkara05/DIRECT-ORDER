import { Inject, Injectable } from '@nestjs/common';
import type {
  Delivery,
  Notification,
  Order,
  OrderStatus,
  Payment,
  Refund,
  Restaurant,
  User,
} from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CursorPage<T> {
  items: T[];
  hasMore: boolean;
}

interface PageOptions {
  cursor?: string;
  limit?: number;
}

function take(limit?: number): number {
  return Math.min(limit ?? 20, 100);
}

function toPage<T extends { id: string }>(rows: T[], limit: number): CursorPage<T> {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

/**
 * Cross-tenant reads for `/admin/*` (Phase 13) — deliberately centralized
 * here rather than adding "admin" methods to each domain's own
 * tenant-scoped repository (`OrderRepository`, `PaymentRepository`,
 * ...). Every other repository in this codebase exists specifically to
 * make an OMITTED tenant filter a compile error
 * (`TenantScopedRepository`'s own doc comment); admin reads are the one
 * place that guarantee is deliberately absent, so keeping them in one
 * clearly-labeled, admin-only file makes that exception visible and
 * auditable rather than scattered as one-off unscoped methods inside
 * files whose whole point is enforcing tenant scoping.
 */
@Injectable()
export class AdminQueryRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listRestaurants(
    filters: { status?: string; search?: string },
    options: PageOptions = {},
  ): Promise<CursorPage<Restaurant>> {
    const limit = take(options.limit);
    const rows = await this.prisma.restaurant.findMany({
      where: {
        ...(filters.status ? { status: filters.status as Restaurant['status'] } : {}),
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' as const } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }

  async listUsers(
    filters: { search?: string },
    options: PageOptions = {},
  ): Promise<CursorPage<User>> {
    const limit = take(options.limit);
    const rows = await this.prisma.user.findMany({
      where: filters.search
        ? {
            OR: [
              { fullName: { contains: filters.search, mode: 'insensitive' as const } },
              { email: { contains: filters.search, mode: 'insensitive' as const } },
            ],
          }
        : {},
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }

  async listOrders(
    filters: { status?: OrderStatus; restaurantId?: string; orderNumber?: string },
    options: PageOptions = {},
  ): Promise<CursorPage<Order>> {
    const limit = take(options.limit);
    const rows = await this.prisma.order.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.restaurantId ? { restaurantId: filters.restaurantId } : {}),
        ...(filters.orderNumber ? { orderNumber: filters.orderNumber } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }

  async findOrderById(id: string): Promise<Order | null> {
    return this.prisma.order.findUnique({ where: { id } });
  }

  async listPayments(
    filters: { status?: string },
    options: PageOptions = {},
  ): Promise<CursorPage<Payment>> {
    const limit = take(options.limit);
    const rows = await this.prisma.payment.findMany({
      where: filters.status ? { status: filters.status as Payment['status'] } : {},
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }

  async listRefunds(
    filters: { status?: string },
    options: PageOptions = {},
  ): Promise<CursorPage<Refund>> {
    const limit = take(options.limit);
    const rows = await this.prisma.refund.findMany({
      where: filters.status ? { status: filters.status as Refund['status'] } : {},
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }

  async listDeliveries(
    filters: { status?: string },
    options: PageOptions = {},
  ): Promise<CursorPage<Delivery>> {
    const limit = take(options.limit);
    const rows = await this.prisma.delivery.findMany({
      where: filters.status ? { status: filters.status as Delivery['status'] } : {},
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }

  async listNotifications(
    filters: { status?: string },
    options: PageOptions = {},
  ): Promise<CursorPage<Notification>> {
    const limit = take(options.limit);
    const rows = await this.prisma.notification.findMany({
      where: filters.status ? { status: filters.status as Notification['status'] } : {},
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }
}
