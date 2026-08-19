import { Inject, Injectable } from '@nestjs/common';
import type { DailyPlatformMetrics, DailyRestaurantMetrics } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface RestaurantDayCounters {
  restaurantId: string;
  date: Date;
  ordersPlaced: number;
  ordersCompleted: number;
  ordersCancelled: number;
  ordersRejected: number;
  grossOrderValueMinor: bigint;
  discountMinor: bigint;
  refundMinor: bigint;
  netOrderValueMinor: bigint;
  avgOrderValueMinor: bigint;
  avgPrepSeconds: number;
  platformFeeRevenueMinor: bigint;
}

export interface PlatformDayCounters {
  date: Date;
  ordersPlaced: number;
  ordersCompleted: number;
  ordersCancelled: number;
  ordersRejected: number;
  grossOrderValueMinor: bigint;
  discountMinor: bigint;
  refundMinor: bigint;
  netOrderValueMinor: bigint;
  avgOrderValueMinor: bigint;
  avgPrepSeconds: number;
  platformFeeRevenueMinor: bigint;
  paymentsAttempted: number;
  paymentsSucceeded: number;
  deliveriesAttempted: number;
  deliveriesSucceeded: number;
  supportCasesOpened: number;
}

/**
 * docs/01 §5.14: "unique (restaurant_id, date) / (date); recomputable
 * and idempotent" — every write here is an upsert, never a plain
 * create, so re-running a rollup for an already-computed day converges
 * on the identical row rather than erroring or duplicating.
 */
@Injectable()
export class DailyMetricsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async upsertRestaurantDay(counters: RestaurantDayCounters): Promise<DailyRestaurantMetrics> {
    const { restaurantId, date, ...rest } = counters;
    return this.prisma.dailyRestaurantMetrics.upsert({
      where: { restaurantId_date: { restaurantId, date } },
      create: { restaurantId, date, ...rest },
      update: { ...rest, computedAt: new Date() },
    });
  }

  async upsertPlatformDay(counters: PlatformDayCounters): Promise<DailyPlatformMetrics> {
    const { date, ...rest } = counters;
    return this.prisma.dailyPlatformMetrics.upsert({
      where: { date },
      create: { date, ...rest },
      update: { ...rest, computedAt: new Date() },
    });
  }

  async findRestaurantRange(restaurantId: string, fromDate: Date, toDate: Date): Promise<DailyRestaurantMetrics[]> {
    return this.prisma.dailyRestaurantMetrics.findMany({
      where: { restaurantId, date: { gte: fromDate, lte: toDate } },
      orderBy: { date: 'asc' },
    });
  }

  async findPlatformRange(fromDate: Date, toDate: Date): Promise<DailyPlatformMetrics[]> {
    return this.prisma.dailyPlatformMetrics.findMany({
      where: { date: { gte: fromDate, lte: toDate } },
      orderBy: { date: 'asc' },
    });
  }

  async findLatestPlatformDay(): Promise<DailyPlatformMetrics | null> {
    return this.prisma.dailyPlatformMetrics.findFirst({ orderBy: { date: 'desc' } });
  }
}
