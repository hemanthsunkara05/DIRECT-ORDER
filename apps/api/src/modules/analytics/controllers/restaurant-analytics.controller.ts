import { Controller, Get, HttpCode, Inject, Query, UseGuards } from '@nestjs/common';
import type { DailyRestaurantMetrics } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { DailyMetricsRepository } from '../repositories/daily-metrics.repository.js';

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 90;

/**
 * `GET /restaurant/analytics/overview` (docs/04-api-specification.md
 * §8.5, MANAGER, `analytics:restaurant`). Reads EXCLUSIVELY from
 * `DailyRestaurantMetrics` — the already-materialized rollup —
 * matching docs/13's "restaurant and admin dashboards from rollups,
 * never live table scans" literally: there is no query against
 * `Order`/`Payment`/`Refund` anywhere in this handler.
 */
@Controller('restaurant/analytics')
@UseGuards(AuthGuard, AuthorizationGuard)
export class RestaurantAnalyticsController {
  constructor(@Inject(DailyMetricsRepository) private readonly metrics: DailyMetricsRepository) {}

  @Get('overview')
  @TenantScoped()
  @Permissions('analytics:restaurant')
  @HttpCode(200)
  async overview(@CurrentTenant() tenant: TenantContext, @Query('days') daysRaw?: string) {
    const days = parseDays(daysRaw);
    const toDate = dateOnlyUtc(new Date());
    const fromDate = new Date(toDate);
    fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));

    const rows = await this.metrics.findRestaurantRange(tenant.restaurantId, fromDate, toDate);
    return ok({ days: rows.map(toDailyView), summary: summarize(rows) });
  }
}

function parseDays(daysRaw?: string): number {
  if (daysRaw === undefined) return DEFAULT_RANGE_DAYS;
  const days = Number.parseInt(daysRaw, 10);
  if (!Number.isFinite(days) || days < 1 || days > MAX_RANGE_DAYS) {
    throw new ValidationError(`days must be between 1 and ${MAX_RANGE_DAYS}.`);
  }
  return days;
}

function dateOnlyUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function toDailyView(row: DailyRestaurantMetrics) {
  return {
    date: row.date.toISOString().slice(0, 10),
    ordersPlaced: row.ordersPlaced,
    ordersCompleted: row.ordersCompleted,
    ordersCancelled: row.ordersCancelled,
    ordersRejected: row.ordersRejected,
    grossOrderValueMinor: row.grossOrderValueMinor.toString(),
    discountMinor: row.discountMinor.toString(),
    refundMinor: row.refundMinor.toString(),
    netOrderValueMinor: row.netOrderValueMinor.toString(),
    avgOrderValueMinor: row.avgOrderValueMinor.toString(),
    avgPrepSeconds: row.avgPrepSeconds,
  };
}

/** A cheap in-memory reduction over already-materialized rollup rows — NOT a second query, and NOT a live scan. */
function summarize(rows: DailyRestaurantMetrics[]) {
  let ordersPlaced = 0;
  let ordersCompleted = 0;
  let ordersCancelled = 0;
  let ordersRejected = 0;
  let grossOrderValueMinor = 0n;
  let discountMinor = 0n;
  let refundMinor = 0n;
  let netOrderValueMinor = 0n;

  for (const row of rows) {
    ordersPlaced += row.ordersPlaced;
    ordersCompleted += row.ordersCompleted;
    ordersCancelled += row.ordersCancelled;
    ordersRejected += row.ordersRejected;
    grossOrderValueMinor += row.grossOrderValueMinor;
    discountMinor += row.discountMinor;
    refundMinor += row.refundMinor;
    netOrderValueMinor += row.netOrderValueMinor;
  }

  return {
    ordersPlaced,
    ordersCompleted,
    ordersCancelled,
    ordersRejected,
    grossOrderValueMinor: grossOrderValueMinor.toString(),
    discountMinor: discountMinor.toString(),
    refundMinor: refundMinor.toString(),
    netOrderValueMinor: netOrderValueMinor.toString(),
    avgOrderValueMinor: (ordersPlaced > 0 ? grossOrderValueMinor / BigInt(ordersPlaced) : 0n).toString(),
  };
}
