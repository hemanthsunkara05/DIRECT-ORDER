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
import { UNCLAIMED_PLACEHOLDER_EMAIL } from '../../../platform/unclaimed-listings.js';

export interface UnclaimedListing {
  slug: string;
  name: string;
  phone: string | null;
  city: string | null;
}

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

  /**
   * Outreach worklist: every restaurant still owned only by the
   * unclaimed-listing placeholder account (see claimRestaurant() /
   * UNCLAIMED_PLACEHOLDER_EMAIL), with just enough to work an outreach
   * queue by hand — name, phone, city, and the slug the claim link is
   * built from (`/signup?claim=<slug>`). Small, bounded batches (this
   * exists for the Rajahmundry outreach list, not an open-ended feed),
   * so a flat list rather than cursor pagination is the honest shape.
   */
  async listUnclaimed(): Promise<UnclaimedListing[]> {
    const placeholder = await this.prisma.user.findUnique({
      where: { email: UNCLAIMED_PLACEHOLDER_EMAIL },
    });
    if (!placeholder) return [];

    // Composed from single-table lookups (staff by userId, then each
    // restaurant/address by id) rather than a relation-filtering
    // findMany — keeps this portable across both the real Prisma client
    // and the in-memory test double, which only implements the simpler
    // per-table query shapes every OTHER repository in this codebase
    // already relies on.
    const staffRows = await this.prisma.restaurantStaff.findMany({
      where: { userId: placeholder.id, role: 'OWNER' as const },
    });

    const listings = await Promise.all(
      staffRows.map(async (staff): Promise<UnclaimedListing | null> => {
        const restaurant = await this.prisma.restaurant.findUnique({
          where: { id: staff.restaurantId },
        });
        if (!restaurant) return null;
        const address = await this.prisma.restaurantAddress.findUnique({
          where: { restaurantId: restaurant.id },
        });
        return { slug: restaurant.slug, name: restaurant.name, phone: restaurant.phone, city: address?.city ?? null };
      }),
    );
    return listings
      .filter((l): l is UnclaimedListing => l !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
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
