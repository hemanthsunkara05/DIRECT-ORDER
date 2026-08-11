import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module.js';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { CustomerRepository } from '../orders/repositories/customer.repository.js';
import { PublicRestaurantRepository } from './repositories/public-restaurant.repository.js';
import { PublicMenuRepository } from './repositories/public-menu.repository.js';
import { PublicRestaurantService } from './services/public-restaurant.service.js';
import { CheckoutQuoteService } from './services/checkout-quote.service.js';
import { PublicRestaurantController } from './controllers/public-restaurant.controller.js';
import { PublicCheckoutController } from './controllers/public-checkout.controller.js';

/**
 * Phase 7 (restaurant/menu), Phase 8 (checkout quote) — all
 * unauthenticated, no IdentityModule import, no AuthGuard anywhere in
 * this module. Imports AvailabilityModule to reuse `isAcceptingOrders()`
 * rather than re-deriving availability logic, (Phase 14) PromotionsModule
 * so `CheckoutQuoteService` can resolve a coupon code through the same
 * `PromotionRepository`/`PromotionEligibilityService` `CheckoutService`/
 * `AdminModule` also use, and (Phase 15) ReviewsModule for
 * `ReviewRepository` (`GET :slug/reviews`). `CustomerRepository` is
 * re-provided here directly rather than imported from `OrdersModule` —
 * the same "thin, stateless, PrismaService-backed — a second instance
 * is exactly as correct as sharing another module's" call
 * `NotificationsModule`/`DeliveryModule` already made for their own
 * copies of shared repositories.
 */
@Module({
  imports: [AvailabilityModule, PromotionsModule, ReviewsModule],
  controllers: [PublicRestaurantController, PublicCheckoutController],
  providers: [
    PublicRestaurantRepository,
    PublicMenuRepository,
    PublicRestaurantService,
    CheckoutQuoteService,
    CustomerRepository,
  ],
  // Phase 9: OrdersModule imports this module to reuse cart/checkout
  // validation and pricing (CartService, CheckoutService) rather than
  // re-deriving it — see CheckoutQuoteService's own doc comment.
  exports: [PublicRestaurantRepository, PublicMenuRepository, CheckoutQuoteService],
})
export class PublicModule {}
