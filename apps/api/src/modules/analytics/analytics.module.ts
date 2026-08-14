import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { AnalyticsEventRepository } from './repositories/analytics-event.repository.js';
import { DailyMetricsRepository } from './repositories/daily-metrics.repository.js';
import { AnalyticsOutboxConsumer } from './services/analytics-outbox-consumer.service.js';
import { AnalyticsRollupService } from './services/analytics-rollup.service.js';
import { RestaurantAnalyticsController } from './controllers/restaurant-analytics.controller.js';

/**
 * Phase 17 (Support and analytics). `AnalyticsOutboxConsumer`/
 * `AnalyticsRollupService` self-register in their own `onModuleInit()`
 * (the outbox relay, an hourly `setInterval` respectively) — listed as
 * providers but never injected anywhere themselves, the same
 * self-starting shape `OutboxService`/`OrderExpiryScheduler`/
 * `LoyaltyReconciliationService` already use. Exported so `AdminModule`
 * (rebuilding `GET /admin/overview` to read from
 * `DailyPlatformMetrics`) and `AnalyticsRollupService` itself (called
 * directly by tests, the same "callable directly, not just via the
 * timer" shape `LoyaltyReconciliationService.reconcile()` established)
 * are both reachable.
 */
@Module({
  imports: [IdentityModule],
  controllers: [RestaurantAnalyticsController],
  providers: [
    AnalyticsEventRepository,
    DailyMetricsRepository,
    AnalyticsOutboxConsumer,
    AnalyticsRollupService,
  ],
  exports: [DailyMetricsRepository, AnalyticsRollupService],
})
export class AnalyticsModule {}
