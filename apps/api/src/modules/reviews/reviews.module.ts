import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { OrderStateModule } from '../orders/order-state.module.js';
import { ReviewRepository } from './repositories/review.repository.js';
import { RatingAggregateService } from './services/rating-aggregate.service.js';
import { ReviewService } from './services/review.service.js';
import { RestaurantReviewsController } from './controllers/restaurant-reviews.controller.js';

/**
 * Phase 15 (Reviews). Imports `OrderStateModule` for `OrderRepository`
 * (review-submission ownership check, the exact same guest-access-token
 * pattern `OrderTrackingService` uses) — not `OrdersModule` itself,
 * since `OrdersModule` is what imports THIS module (`OrderTrackingController`
 * gains the submit-review endpoint), and importing it back would cycle.
 */
@Module({
  imports: [IdentityModule, OrderStateModule],
  controllers: [RestaurantReviewsController],
  providers: [ReviewRepository, RatingAggregateService, ReviewService],
  exports: [ReviewRepository, RatingAggregateService, ReviewService],
})
export class ReviewsModule {}
