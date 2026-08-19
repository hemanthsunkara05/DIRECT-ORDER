import { Inject, Injectable } from '@nestjs/common';
import type {
  Delivery,
  Notification,
  Order,
  OrderStatus,
  Payment,
  Refund,
  Restaurant,
  RestaurantAddress,
  RestaurantBranding,
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

export interface RestaurantDetail {
  restaurant: Restaurant;
  address: RestaurantAddress | null;
  branding: RestaurantBranding | null;
  menuSummary: { categoryCount: number; itemCount: number };
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
    /**
     * Phase 21a: `'oldest'` sorts by `submittedAt` ascending — the
     * Approval Queue's FIFO order. `'newest'` (default, unchanged
     * behavior) sorts by `createdAt` descending, same as before this
     * phase. Deliberately NOT `submittedAt desc` for the default case —
     * every existing caller of this method expects `createdAt`
     * ordering and this stays a strict no-op for them.
     */
    order: 'newest' | 'oldest' = 'newest',
  ): Promise<CursorPage<Restaurant>> {
    const limit = take(options.limit);
    const rows = await this.prisma.restaurant.findMany({
      where: {
        ...(filters.status ? { status: filters.status as Restaurant['status'] } : {}),
        ...(filters.search
          ? { name: { contains: filters.search, mode: 'insensitive' as const } }
          : {}),
      },
      orderBy: order === 'oldest' ? { submittedAt: 'asc' } : { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }

  /**
   * Phase 21a: the Approval Queue's per-restaurant decision view —
   * address, a menu summary, and branding, none of which the flat list
   * above returns. Found missing during `/plan-design-review`'s
   * outside-voice pass: the queue page cannot show "everything needed
   * to decide" (the task brief's explicit requirement) without this.
   * Composed from single-table lookups, matching `listUnclaimed()`'s
   * own established convention in this file (portable across the real
   * Prisma client and the in-memory test double).
   */
  async getRestaurantDetail(restaurantId: string): Promise<RestaurantDetail | null> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) return null;

    const address = await this.prisma.restaurantAddress.findUnique({
      where: { restaurantId },
    });
    const branding = await this.prisma.restaurantBranding.findUnique({
      where: { restaurantId },
    });
    const categories = await this.prisma.menuCategory.findMany({
      where: { restaurantId, archivedAt: null },
    });
    const itemCount = await this.prisma.menuItem.count({
      where: { restaurantId, archivedAt: null },
    });

    return {
      restaurant,
      address,
      branding,
      menuSummary: { categoryCount: categories.length, itemCount },
    };
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

  /** Admin order detail (`GET /admin/orders/:id/detail`) — full relations, cross-tenant (no restaurantId scoping, unlike `OrderRepository.findByIdForRestaurant`). */
  async findOrderDetailById(id: string) {
    return this.prisma.order.findUnique({
      where: { id },
      include: {
        items: true,
        history: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' } },
        delivery: true,
      },
    });
  }

  /**
   * Admin command center's order-lifecycle funnel (Phase 23a). The five
   * active statuses are LIVE counts (an order sits in one of these
   * regardless of which day it was placed, so no date filter — same
   * "cheap, indexed, no rollup equivalent" justification as
   * `restaurantsByStatus` above). The three terminal statuses would
   * otherwise grow unbounded forever, so those three are scoped to
   * "today" specifically, each against the timestamp that actually
   * marks the transition: `deliveredAt`/`cancelledAt` columns exist
   * directly on `Order`, but REJECTED has no dedicated timestamp column
   * — `OrderStatusHistory` is the same source `AnalyticsRollupService`
   * already reads for its own `ordersRejected` rollup count, reused
   * here rather than inventing a second way to answer "was this
   * rejected today".
   */
  async orderFunnel(todayStart: Date): Promise<{
    PLACED: number;
    ACCEPTED: number;
    PREPARING: number;
    READY_FOR_PICKUP: number;
    OUT_FOR_DELIVERY: number;
    DELIVERED_TODAY: number;
    CANCELLED_TODAY: number;
    REJECTED_TODAY: number;
  }> {
    const [PLACED, ACCEPTED, PREPARING, READY_FOR_PICKUP, OUT_FOR_DELIVERY, DELIVERED_TODAY, CANCELLED_TODAY, REJECTED_TODAY] =
      await Promise.all([
        this.prisma.order.count({ where: { status: 'PLACED' } }),
        this.prisma.order.count({ where: { status: 'ACCEPTED' } }),
        this.prisma.order.count({ where: { status: 'PREPARING' } }),
        this.prisma.order.count({ where: { status: 'READY_FOR_PICKUP' } }),
        this.prisma.order.count({ where: { status: 'OUT_FOR_DELIVERY' } }),
        this.prisma.order.count({ where: { status: 'DELIVERED', deliveredAt: { gte: todayStart } } }),
        this.prisma.order.count({ where: { status: 'CANCELLED', cancelledAt: { gte: todayStart } } }),
        this.prisma.orderStatusHistory.count({ where: { toStatus: 'REJECTED', createdAt: { gte: todayStart } } }),
      ]);
    return { PLACED, ACCEPTED, PREPARING, READY_FOR_PICKUP, OUT_FOR_DELIVERY, DELIVERED_TODAY, CANCELLED_TODAY, REJECTED_TODAY };
  }

  /**
   * Priority alerts: orders that have been sitting in one non-terminal
   * status past `thresholdMinutes` (D2: 45 minutes, a documented,
   * user-confirmed starting threshold — see the controller's own
   * comment for why no pre-existing business rule covers this). Uses
   * `updatedAt` as "time since last status change" — every transition
   * through `OrderStateService.transition()` updates the row, so this
   * is accurate without needing a dedicated "status changed at" column.
   */
  async listStuckOrders(thresholdMinutes: number): Promise<Order[]> {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);
    return this.prisma.order.findMany({
      where: {
        status: { in: ['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'] },
        updatedAt: { lt: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
    });
  }

  /** Priority alerts: restaurants PENDING_APPROVAL longer than `thresholdHours` (D2: 24 hours). */
  async listOverdueApprovals(thresholdHours: number): Promise<Restaurant[]> {
    const cutoff = new Date(Date.now() - thresholdHours * 60 * 60_000);
    return this.prisma.restaurant.findMany({
      where: { status: 'PENDING_APPROVAL', submittedAt: { lt: cutoff } },
      orderBy: { submittedAt: 'asc' },
    });
  }

  /**
   * Top restaurants by order count over a window (Phase 23a). GMV
   * ranking is deferred to a follow-up — order count is a live,
   * per-restaurant `count()` (same cost class as `listOrderDirectory`
   * above, already proven fine at this scale); a GMV ranking would need
   * a live `sum()` per restaurant instead of a `count()`, which is a
   * heavier query for the same small restaurant list — fine to add
   * later if the order-count ranking proves insufficient, not blocking
   * this phase.
   */
  async topRestaurantsByOrderCount(
    windowStart: Date,
    limit: number,
  ): Promise<{ restaurantId: string; name: string; orderCount: number }[]> {
    const restaurants = await this.prisma.restaurant.findMany({ where: { status: 'ACTIVE' } });
    const withCounts = await Promise.all(
      restaurants.map(async (restaurant) => ({
        restaurantId: restaurant.id,
        name: restaurant.name,
        orderCount: await this.prisma.order.count({
          where: { restaurantId: restaurant.id, createdAt: { gte: windowStart } },
        }),
      })),
    );
    return withCounts.sort((a, b) => b.orderCount - a.orderCount).slice(0, limit);
  }

  /**
   * Orders & payments' city → restaurant drill-down (docs feedback:
   * "orders should be sorted according to the restaurants. city ->
   * restaurant -> orders"). A one-shot summary, not cursor-paginated —
   * same "small, bounded batches, flat/nested list rather than cursor
   * pagination is the honest shape" reasoning `listUnclaimed()` above
   * already established: this is a pilot with a handful of restaurants
   * per city, not an open-ended feed. The actual per-restaurant ORDERS
   * are still fetched through the existing paginated `listOrders()`
   * once an admin drills into one — this method only returns enough to
   * build the navigation tree (name, slug, city, and a status-filtered
   * order count per restaurant).
   */
  async listOrderDirectory(filters: {
    status?: OrderStatus;
  }): Promise<{ restaurantId: string; name: string; slug: string; city: string | null; orderCount: number }[]> {
    const restaurants = await this.prisma.restaurant.findMany({});
    return Promise.all(
      restaurants.map(async (restaurant) => {
        const [address, orderCount] = await Promise.all([
          this.prisma.restaurantAddress.findUnique({ where: { restaurantId: restaurant.id } }),
          this.prisma.order.count({
            where: {
              restaurantId: restaurant.id,
              ...(filters.status ? { status: filters.status } : {}),
            },
          }),
        ]);
        return {
          restaurantId: restaurant.id,
          name: restaurant.name,
          slug: restaurant.slug,
          city: address?.city ?? null,
          orderCount,
        };
      }),
    );
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
