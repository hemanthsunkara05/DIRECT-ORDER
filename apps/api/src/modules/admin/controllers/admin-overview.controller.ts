import { Controller, Get, HttpCode, Inject, UseGuards } from '@nestjs/common';
import type { DailyPlatformMetrics } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { RedisService } from '../../../platform/redis/redis.service.js';
import { DailyMetricsRepository } from '../../analytics/repositories/daily-metrics.repository.js';

const TREND_DAYS = 7;

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
    paymentsAttempted: row.paymentsAttempted,
    paymentsSucceeded: row.paymentsSucceeded,
    deliveriesAttempted: row.deliveriesAttempted,
    deliveriesSucceeded: row.deliveriesSucceeded,
    supportCasesOpened: row.supportCasesOpened,
  };
}
