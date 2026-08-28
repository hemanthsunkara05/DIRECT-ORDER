import { Controller, Get, HttpCode, Inject, UseGuards } from '@nestjs/common';
import type { DailyPlatformMetrics } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { RedisService } from '../../../platform/redis/redis.service.js';
import { DailyMetricsRepository } from '../../analytics/repositories/daily-metrics.repository.js';
import { AdminQueryRepository } from '../repositories/admin-query.repository.js';
import { dateKeyToUtcDate, localMidnightToUtc, toLocalMoment } from '../../availability/timezone.js';

const TREND_DAYS = 7;

/**
 * Priority-alert thresholds for the command center (Phase 23a, D2).
 * Neither number is derived from an existing documented business rule
 * — docs/03-state-machines.md and docs/06-business-rules.md were
 * searched in full and neither defines "stuck" or "waiting too long"
 * for these cases. Confirmed with sash as a defensible starting point
 * (roughly double a typical restaurant prep window; a same-business-
 * day approval expectation), deliberately kept as plain constants
 * rather than schema so they're trivially tunable later.
 */
const STUCK_ORDER_MINUTES = 45;
const PENDING_APPROVAL_HOURS = 24;
const TOP_RESTAURANTS_LIMIT = 10;

/**
 * `GET /admin/overview`, `GET /admin/health` (docs/04 §8.7, "Any
 * admin"). `restaurant:read` is used as the permission gate on both —
 * it is the one permission every admin role holds (docs/05 §9.2's
 * matrix), the closest match to "any admin" the catalogue actually
 * encodes; there is no dedicated "admin-only, no specific capability"
 * permission and adding one just for this would be one more catalogue
 * row nothing else needs.
 *
 * `metrics` now reads exclusively from `DailyPlatformMetrics` (Phase
 * 17) — the "platform metrics from rollups" docs/04 always described
 * for this endpoint, previously an honestly-flagged placeholder (see
 * PHASE_REPORTS.md's Phase 13 entry) reporting a live `orders.count()`
 * scan instead. `restaurantsByStatus`/`activeAdmins` remain live reads
 * deliberately: they are cheap, indexed counts over small tables
 * (`restaurants`, `admin_users`), not the kind of unbounded scan over
 * `orders`/`payments` this phase's "never live table scans" is
 * actually about, AND neither has a rollup equivalent to read instead
 * — `DailyPlatformMetrics` models order/payment/delivery/support
 * activity, not restaurant onboarding status or admin headcount.
 * `metrics` is necessarily "as of yesterday" (rollups run for
 * completed days, never a still-accumulating "today"), shown
 * explicitly via `metrics.asOfDate` rather than implied.
 */
@Controller('admin')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminOverviewController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(DailyMetricsRepository) private readonly dailyMetrics: DailyMetricsRepository,
    @Inject(AdminQueryRepository) private readonly admin: AdminQueryRepository,
  ) {}

  @Get('overview')
  @Permissions('restaurant:read')
  @HttpCode(200)
  async overview() {
    const [restaurantsByStatus, activeAdmins, latest] = await Promise.all([
      this.prisma.restaurant.groupBy({ by: ['status'], _count: true }),
      this.prisma.adminUser.count({ where: { status: 'ACTIVE' } }),
      this.dailyMetrics.findLatestPlatformDay(),
    ]);

    const trend = latest
      ? await this.dailyMetrics.findPlatformRange(rangeStart(latest.date, TREND_DAYS), latest.date)
      : [];

    return ok({
      restaurantsByStatus: Object.fromEntries(restaurantsByStatus.map((r) => [r.status, r._count])),
      activeAdmins,
      metrics: {
        asOfDate: latest ? latest.date.toISOString().slice(0, 10) : null,
        latest: latest ? toMetricsView(latest) : null,
        trend: trend.map(toMetricsView),
      },
    });
  }

  /**
   * Admin command center (Phase 23a). Gated by `analytics:platform` —
   * the existing permission for platform-wide analytics, already held
   * by exactly ADMIN_OPERATIONS/ADMIN_FINANCE/SUPER_ADMIN (docs/05
   * §9.2), a better fit than reusing `restaurant:read`'s "any admin"
   * stand-in the way `overview()` above does, since this genuinely is
   * an analytics surface, not a generic admin capability.
   *
   * `kpis` reads `DailyPlatformMetrics` exclusively for money/order
   * figures (today's row now exists thanks to the rollup fix earlier
   * this session — `metrics.latest` here is genuinely today, not
   * "yesterday" the way `overview()`'s own doc comment still correctly
   * describes for ITS OWN unrelated historical-trend use). `funnel`,
   * `alerts`, and `topRestaurants` are live, indexed queries — same
   * "cheap, no rollup equivalent" justification as `restaurantsByStatus`
   * above, not a violation of the rollup-only rule (that rule is about
   * unbounded scans over the full order/payment history, not a handful
   * of indexed counts at pilot scale).
   */
  @Get('overview/command-center')
  @Permissions('analytics:platform')
  @HttpCode(200)
  async commandCenter() {
    // Two DIFFERENT "today" boundaries are needed here, and conflating
    // them is exactly the bug this comment replaces. `DailyPlatformMetrics
    // .date` is a pure date-KEY (AnalyticsRollupService stores it via
    // `dateKeyToUtcDate`, which parses "2026-08-26" as literal UTC
    // midnight — a label, not a real instant). `Order.createdAt`/
    // `placedAt` are real timestamps, so `funnel`/`topRestaurants` need
    // the actual IST-midnight INSTANT (`startOfTodayIst()` /
    // `localMidnightToUtc`, 5.5h behind the date-key's literal value).
    // Using the real-instant boundary against the date-key column (or
    // vice versa) silently misses today's row for the ~5.5h/day window
    // where IST has already crossed into a new calendar day but UTC
    // hasn't — found live via scripts/dup-load-test.ts: the rollup had
    // genuinely written `ordersPlaced: 300` for today, but every
    // boundary tried against it (including an initial wrong fix here)
    // missed the row until this distinction was made explicit.
    const todayDateKey = toLocalMoment(new Date(), 'Asia/Kolkata').dateKey;
    const todayRollupDate = dateKeyToUtcDate(todayDateKey);
    const todayIst = startOfTodayIst();
    const [restaurantsByStatus, trendRaw, funnel, stuckOrders, overdueApprovals, topRestaurants] =
      await Promise.all([
        this.prisma.restaurant.groupBy({ by: ['status'], _count: true }),
        this.dailyMetrics.findPlatformRange(rangeStart(todayRollupDate, TREND_DAYS), todayRollupDate),
        this.admin.orderFunnel(todayIst),
        this.admin.listStuckOrders(STUCK_ORDER_MINUTES),
        this.admin.listOverdueApprovals(PENDING_APPROVAL_HOURS),
        this.admin.topRestaurantsByOrderCount(rangeStart(todayIst, 7), TOP_RESTAURANTS_LIMIT),
      ]);

    // Trend rows are ascending by date; the last entry is "today" (if
    // the rollup has run today already) and the second-to-last is
    // "yesterday" — the day-over-day comparison this KPI set uses.
    const today = trendRaw.at(-1) ?? null;
    const yesterday = trendRaw.length > 1 ? trendRaw.at(-2)! : null;
    const weekSum = sumWeek(trendRaw);

    const byStatus = Object.fromEntries(restaurantsByStatus.map((r) => [r.status, r._count]));

    return ok({
      kpis: {
        ordersToday: today?.ordersPlaced ?? 0,
        ordersYesterday: yesterday?.ordersPlaced ?? null,
        ordersThisWeek: weekSum.ordersPlaced,
        gmvTodayMinor: (today?.grossOrderValueMinor ?? 0n).toString(),
        gmvYesterdayMinor: yesterday ? yesterday.grossOrderValueMinor.toString() : null,
        gmvThisWeekMinor: weekSum.grossOrderValueMinor.toString(),
        platformFeeRevenueTodayMinor: (today?.platformFeeRevenueMinor ?? 0n).toString(),
        platformFeeRevenueYesterdayMinor: yesterday ? yesterday.platformFeeRevenueMinor.toString() : null,
        platformFeeRevenueThisWeekMinor: weekSum.platformFeeRevenueMinor.toString(),
        refundMinorToday: (today?.refundMinor ?? 0n).toString(),
        restaurantsLive: byStatus.ACTIVE ?? 0,
        restaurantsPendingApproval: byStatus.PENDING_APPROVAL ?? 0,
      },
      funnel,
      alerts: {
        stuckOrders: stuckOrders.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          restaurantId: o.restaurantId,
          status: o.status,
          // eslint-disable-next-line no-restricted-syntax -- not money: elapsed minutes
          minutesSinceUpdate: Math.round((Date.now() - o.updatedAt.getTime()) / 60_000),
        })),
        overdueApprovals: overdueApprovals.map((r) => ({
          id: r.id,
          name: r.name,
          slug: r.slug,
          hoursWaiting: r.submittedAt
            ? // eslint-disable-next-line no-restricted-syntax -- not money: elapsed hours
              Math.round((Date.now() - r.submittedAt.getTime()) / 3_600_000)
            : null,
        })),
      },
      topRestaurants,
    });
  }

  @Get('health')
  @Permissions('restaurant:read')
  @HttpCode(200)
  async health() {
    const [database, redis] = await Promise.all([
      this.prisma
        .ping()
        .then(() => ({ status: 'ok' as const }))
        .catch((error: unknown) => ({
          status: 'error' as const,
          error: error instanceof Error ? error.message : 'Unknown database error',
        })),
      this.redis.client
        .ping()
        .then(() => ({ status: 'ok' as const }))
        .catch((error: unknown) => ({
          status: 'error' as const,
          error: error instanceof Error ? error.message : 'Unknown redis error',
        })),
    ]);
    return ok({ database, redis });
  }
}

function rangeStart(latestDate: Date, days: number): Date {
  const start = new Date(latestDate);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

/** Platform-wide "today" boundary — Asia/Kolkata, matching `AnalyticsRollupService.rollupPlatformDay`'s own timezone choice for the platform-level rollup, never the server's local time. */
function startOfTodayIst(): Date {
  const dateKey = toLocalMoment(new Date(), 'Asia/Kolkata').dateKey;
  return localMidnightToUtc(dateKey, 'Asia/Kolkata');
}

function sumWeek(rows: DailyPlatformMetrics[]): {
  ordersPlaced: number;
  grossOrderValueMinor: bigint;
  platformFeeRevenueMinor: bigint;
} {
  let ordersPlaced = 0;
  let grossOrderValueMinor = 0n;
  let platformFeeRevenueMinor = 0n;
  for (const row of rows) {
    ordersPlaced += row.ordersPlaced;
    grossOrderValueMinor += row.grossOrderValueMinor;
    platformFeeRevenueMinor += row.platformFeeRevenueMinor;
  }
  return { ordersPlaced, grossOrderValueMinor, platformFeeRevenueMinor };
}

function toMetricsView(row: DailyPlatformMetrics) {
  return {
    date: row.date.toISOString().slice(0, 10),
    ordersPlaced: row.ordersPlaced,
    ordersCompleted: row.ordersCompleted,
    ordersCancelled: row.ordersCancelled,
    ordersRejected: row.ordersRejected,
    grossOrderValueMinor: row.grossOrderValueMinor.toString(),
    netOrderValueMinor: row.netOrderValueMinor.toString(),
    refundMinor: row.refundMinor.toString(),
    platformFeeRevenueMinor: row.platformFeeRevenueMinor.toString(),
    paymentsAttempted: row.paymentsAttempted,
    paymentsSucceeded: row.paymentsSucceeded,
    deliveriesAttempted: row.deliveriesAttempted,
    deliveriesSucceeded: row.deliveriesSucceeded,
    supportCasesOpened: row.supportCasesOpened,
  };
}
