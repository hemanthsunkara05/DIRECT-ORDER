import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { PromotionRepository } from './repositories/promotion.repository.js';
import { PromotionEligibilityService } from './services/promotion-eligibility.service.js';
import { PromotionReservationService } from './services/promotion-reservation.service.js';
import { PromotionOutboxConsumer } from './services/promotion-outbox-consumer.service.js';
import { RestaurantPromotionsController } from './controllers/restaurant-promotions.controller.js';

/**
 * Phase 14 (Promotions). `PromotionOutboxConsumer` registers itself
 * with the global `OutboxService` in its own `onModuleInit()` — the
 * same runtime-hook pattern `NotificationDispatchService` established
 * in Phase 12, not a module import in either direction
 * (`OutboxModule` is `@Global()`, so no explicit import is needed here
 * at all).
 *
 * Exports `PromotionRepository`, `PromotionEligibilityService`, and
 * `PromotionReservationService` — `CheckoutModule`/`PublicModule`
 * (checkout + quote) and `AdminModule` (`/admin/promotions`) both
 * consume these directly rather than duplicating coupon logic.
 */
@Module({
  imports: [IdentityModule],
  controllers: [RestaurantPromotionsController],
  providers: [
    PromotionRepository,
    PromotionEligibilityService,
    PromotionReservationService,
    PromotionOutboxConsumer,
  ],
  exports: [PromotionRepository, PromotionEligibilityService, PromotionReservationService],
})
export class PromotionsModule {}
