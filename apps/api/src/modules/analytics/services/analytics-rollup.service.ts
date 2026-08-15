import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { localMidnightToUtc, toLocalMoment } from '../../availability/timezone.js';
import { DailyMetricsRepository } from '../repositories/daily-metrics.repository.js';

const ROLLUP_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly check — see onModuleInit's own doc comment for why this is safe to run more often than the job itself needs to.

interface OrderDayRow {
  id: string;
  status: string;
  placedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  itemsSubtotalMinor: bigint;
  packagingFeeMinor: bigint;
  deliveryFeeMinor: bigint;
  platformFeeMinor: bigint;
  taxMinor: bigint;
  discountMinor: bigint;
  loyaltyDiscountMinor: bigint;
  payableTotalMinor: bigint;
}

interface AggregatedCounters {
  ordersPlaced: number;
  ordersCompleted: number;
  ordersCancelled: number;
  grossOrderValueMinor: bigint;
  discountMinor: bigint;
  avgOrderValueMinor: bigint;
  avgPrepSeconds: number;
}

/**
 * docs/13-implementation-phases.md Phase 17: "daily rollup jobs...
 * never live table scans" for dashboards. Deliberately recomputes
 * DIRECTLY from `Order`/`Payment`/`Refund`/`OrderStatusHistory`/
 * `SupportCase` — the actual transactional source of truth — NEVER
 * from `AnalyticsEvent` (docs/01 §5.14 itself: "never used as a
 * transactional source of truth"), so "rollups reconcile with source
 * data" holds by construction: a rollup and a from-scratch query
 * against the same source rows are, definitionally, the same
 * computation. `AnalyticsEvent`'s own ingest pipeline can drop or
 * duplicate an event without ever affecting a rollup's correctness.
 *
 * Every date boundary is resolved via `localMidnightToUtc`/
 * `toLocalMoment` in the RESTAURANT's own timezone
 * (`RestaurantSettings.timezone`) for restaurant-level rollups, and
 * `Asia/Kolkata` (docs/10-infrastructure-deployment.md's own default
 * deployment region) for the platform-level rollup — never the
 * server's local time.
 */
@Injectable()
export class AnalyticsRollupService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DailyMetricsRepository) private readonly metrics: DailyMetricsRepository,
  ) {}

  /**
   * Same lightweight self-starting in-process poller shape as
   * `OrderExpiryScheduler`/`LoyaltyReconciliationService` — checks
   * hourly whether "yesterday" (platform-wide, Asia/Kolkata) has been
   * rolled up yet for every ACTIVE restaurant, and does so if not.
   * Idempotent (`DailyMetricsRepository` always upserts), so running
   * this check more often than the once-a-day cadence the docs name
   * ("Daily 01:00 IST") is harmless — it just means the rollup for a
   * new day appears within an hour of midnight rather than exactly at
   * 01:00, and re-checking an already-rolled-up day is a fast no-op
   * upsert of identical values. Phase 19: stores and clears its own
   * timer on `onModuleDestroy` — see `LoyaltyReconciliationService`'s
   * identical fix for why `.unref()` alone wasn't enough.
   */
  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.rollupYesterdayForAllRestaurants().catch(() => {
        /* best-effort background job — see LoyaltyReconciliationService's identical reasoning. */
      });
    }, ROLLUP_CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async rollupYesterdayForAllRestaurants(): Promise<void> {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const restaurants = await this.prisma.restaurant.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, timezone: true },
    });
    for (const restaurant of restaurants) {
      // "Yesterday" is computed independently in EACH restaurant's own
      // timezone, not derived from the platform default — a restaurant
      // in a different IANA zone would otherwise have its rollup keyed
      // to the wrong local calendar date.
      const timezone = restaurant.timezone;
      const localDateKey = toLocalMoment(oneDayAgo, timezone).dateKey;
      await this.rollupRestaurantDay(restaurant.id, localDateKey, timezone);
    }
    await this.rollupPlatformDay(toLocalMoment(oneDayAgo, 'Asia/Kolkata').dateKey);
  }

  async rollupRestaurantDay(restaurantId: string, dateKey: string, timezone: string) {
    const { start, end } = dayBoundsUtc(dateKey, timezone);
    const orders = await this.fetchOrderDayRows({ restaurantId }, start, end);
    const counters = aggregateOrders(orders);

    const ordersRejected = await this.prisma.orderStatusHistory.count({
      where: { toStatus: 'REJECTED', createdAt: { gte: start, lt: end }, order: { restaurantId } },
    });
    const refundAgg = await this.prisma.refund.aggregate({
      where: { status: 'COMPLETED', completedAt: { gte: start, lt: end }, payment: { order: { restaurantId } } },
      _sum: { amountMinor: true },
    });
    const refundMinor = refundAgg._sum.amountMinor ?? 0n;

    return this.metrics.upsertRestaurantDay({
      restaurantId,
      date: dateOnlyUtc(dateKey),
      ordersPlaced: counters.ordersPlaced,
      ordersCompleted: counters.ordersCompleted,
      ordersCancelled: counters.ordersCancelled,
      ordersRejected,
      grossOrderValueMinor: counters.grossOrderValueMinor,
      discountMinor: counters.discountMinor,
      refundMinor,
      netOrderValueMinor: counters.grossOrderValueMinor - counters.discountMinor - refundMinor,
      avgOrderValueMinor: counters.avgOrderValueMinor,
      avgPrepSeconds: counters.avgPrepSeconds,
    });
  }

  async rollupPlatformDay(dateKey: string) {
    const timezone = 'Asia/Kolkata';
    const { start, end } = dayBoundsUtc(dateKey, timezone);
    const orders = await this.fetchOrderDayRows({}, start, end);
    const counters = aggregateOrders(orders);

    const ordersRejected = await this.prisma.orderStatusHistory.count({
      where: { toStatus: 'REJECTED', createdAt: { gte: start, lt: end } },
    });
    const refundAgg = await this.prisma.refund.aggregate({
      where: { status: 'COMPLETED', completedAt: { gte: start, lt: end } },
      _sum: { amountMinor: true },
    });
    const refundMinor = refundAgg._sum.amountMinor ?? 0n;

    const [paymentsAttempted, paymentsSucceeded, deliveriesAttempted, deliveriesSucceeded, supportCasesOpened] =
      await Promise.all([
        this.prisma.payment.count({ where: { createdAt: { gte: start, lt: end } } }),
        this.prisma.payment.count({
          where: { createdAt: { gte: start, lt: end }, status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
        }),
        this.prisma.delivery.count({ where: { createdAt: { gte: start, lt: end } } }),
        this.prisma.delivery.count({ where: { createdAt: { gte: start, lt: end }, status: 'DELIVERED' } }),
        this.prisma.supportCase.count({ where: { createdAt: { gte: start, lt: end } } }),
      ]);

    return this.metrics.upsertPlatformDay({
      date: dateOnlyUtc(dateKey),
      ordersPlaced: counters.ordersPlaced,
      ordersCompleted: counters.ordersCompleted,
      ordersCancelled: counters.ordersCancelled,
      ordersRejected,
      grossOrderValueMinor: counters.grossOrderValueMinor,
      discountMinor: counters.discountMinor,
      refundMinor,
      netOrderValueMinor: counters.grossOrderValueMinor - counters.discountMinor - refundMinor,
      avgOrderValueMinor: counters.avgOrderValueMinor,
      avgPrepSeconds: counters.avgPrepSeconds,
      paymentsAttempted,
      paymentsSucceeded,
      deliveriesAttempted,
      deliveriesSucceeded,
      supportCasesOpened,
    });
  }

  private async fetchOrderDayRows(
    scope: { restaurantId?: string },
    start: Date,
    end: Date,
  ): Promise<OrderDayRow[]> {
    return this.prisma.order.findMany({
      where: {
        ...scope,
        OR: [
          { placedAt: { gte: start, lt: end } },
          { deliveredAt: { gte: start, lt: end } },
          { cancelledAt: { gte: start, lt: end } },
        ],
      },
      select: {
        id: true,
        status: true,
        placedAt: true,
        deliveredAt: true,
        cancelledAt: true,
        acceptedAt: true,
        readyAt: true,
        itemsSubtotalMinor: true,
        packagingFeeMinor: true,
        deliveryFeeMinor: true,
        platformFeeMinor: true,
        taxMinor: true,
        discountMinor: true,
        loyaltyDiscountMinor: true,
        payableTotalMinor: true,
      },
    });
  }
}

/**
 * All three counts/sums below are independently gated on their OWN
 * timestamp falling in range — a single order can therefore count as
 * "placed" on one rollup's day and "completed" on a LATER day's rollup
 * (whichever day each transition actually happened), never double
 * counted within the same metric, and never forced into one shared
 * bucket the way a single `createdAt`-only query would.
 */
function aggregateOrders(orders: OrderDayRow[]): AggregatedCounters {
  let ordersPlaced = 0;
  let ordersCompleted = 0;
  let ordersCancelled = 0;
  let grossOrderValueMinor = 0n;
  let discountMinor = 0n;
  let prepSecondsSum = 0;
  let prepSamples = 0;

  for (const order of orders) {
    if (order.placedAt) {
      ordersPlaced += 1;
      grossOrderValueMinor +=
        order.itemsSubtotalMinor +
        order.packagingFeeMinor +
        order.deliveryFeeMinor +
        order.platformFeeMinor +
        order.taxMinor;
      discountMinor += order.discountMinor + order.loyaltyDiscountMinor;
    }
    if (order.deliveredAt) {
      ordersCompleted += 1;
      if (order.acceptedAt && order.readyAt) {
        // eslint-disable-next-line no-restricted-syntax -- not money: prep time in seconds
        prepSecondsSum += Math.round((order.readyAt.getTime() - order.acceptedAt.getTime()) / 1000);
        prepSamples += 1;
      }
    }
    if (order.cancelledAt && order.status === 'CANCELLED') {
      ordersCancelled += 1;
    }
  }

  return {
    ordersPlaced,
    ordersCompleted,
    ordersCancelled,
    grossOrderValueMinor,
    discountMinor,
    avgOrderValueMinor: ordersPlaced > 0 ? grossOrderValueMinor / BigInt(ordersPlaced) : 0n,
    // eslint-disable-next-line no-restricted-syntax -- not money: average prep time in seconds
    avgPrepSeconds: prepSamples > 0 ? Math.round(prepSecondsSum / prepSamples) : 0,
  };
}

function dayBoundsUtc(dateKey: string, timezone: string): { start: Date; end: Date } {
  const start = localMidnightToUtc(dateKey, timezone);
  const nextDateKey = addOneDay(dateKey);
  const end = localMidnightToUtc(nextDateKey, timezone);
  return { start, end };
}

function addOneDay(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d));
  date.setUTCDate(date.getUTCDate() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** `@db.Date` columns want a UTC-midnight `Date` matching the calendar date, independent of any timezone math — the value stored is a plain calendar date, not an instant. */
function dateOnlyUtc(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d));
}
