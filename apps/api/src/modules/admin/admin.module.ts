import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { OrderStateModule } from '../orders/order-state.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ReconciliationIssueRepository } from '../payments/repositories/reconciliation-issue.repository.js';
import { RestaurantRepository } from '../restaurants/repositories/restaurant.repository.js';
import { RestaurantsModule } from '../restaurants/restaurants.module.js';
import { AvailabilityModule } from '../availability/availability.module.js';
import { MenuModule } from '../menu/menu.module.js';
import { NotificationRepository } from '../notifications/repositories/notification.repository.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { SupportModule } from '../support/support.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { AdminQueryRepository } from './repositories/admin-query.repository.js';
import { RestaurantStateService } from './services/restaurant-state.service.js';
import { AdminRestaurantContentService } from './services/admin-restaurant-content.service.js';
import { AdminUserService } from './services/admin-user.service.js';
import { AdminOrderService } from './services/admin-order.service.js';
import { AdminReviewService } from './services/admin-review.service.js';
import { AdminLoyaltyService } from './services/admin-loyalty.service.js';
import { AdminSupportService } from './services/admin-support.service.js';
import { AdminRestaurantsController } from './controllers/admin-restaurants.controller.js';
import { AdminRestaurantContentController } from './controllers/admin-restaurant-content.controller.js';
import { AdminRestaurantMenuController } from './controllers/admin-restaurant-menu.controller.js';
import { AdminUploadController } from './controllers/admin-upload.controller.js';
import { AdminUsersController } from './controllers/admin-users.controller.js';
import { AdminOrdersController } from './controllers/admin-orders.controller.js';
import { AdminPaymentsController } from './controllers/admin-payments.controller.js';
import { AdminOperationsController } from './controllers/admin-operations.controller.js';
import { AdminAuditController } from './controllers/admin-audit.controller.js';
import { AdminOverviewController } from './controllers/admin-overview.controller.js';
import { AdminPromotionsController } from './controllers/admin-promotions.controller.js';
import { AdminReviewsController } from './controllers/admin-reviews.controller.js';
import { AdminLoyaltyController } from './controllers/admin-loyalty.controller.js';
import { AdminSupportController } from './controllers/admin-support.controller.js';

/**
 * Phase 13 (Admin panel). `AdminUserRepository` itself is NOT provided
 * here — it is `@Global()` via `AuthorizationModule` (Phase 4, extended
 * this phase), the same platform-layer placement `RestaurantMembershipRepository`
 * already has.
 *
 * Imports `PaymentsModule` (for `PAYMENT_PROVIDER`, `PaymentRepository`,
 * `RefundService`) rather than re-providing any of them here — a
 * caught-during-testing bug, not a style choice: `MockPaymentProvider`
 * holds real in-memory state (`byOrderId`/`byPaymentId` maps), so a
 * SECOND, separately-provided instance of that class (as an earlier
 * version of this module had) is a genuinely different object with its
 * own empty maps — every payment simulated through the real checkout
 * flow (which resolves `PAYMENT_PROVIDER` from `PaymentsModule`'s own
 * instance) became invisible to that second instance, breaking five
 * unrelated test files that call `ctx.app.get(MockPaymentProvider)`.
 * Reusing the SAME module-exported singleton is not just tidier, it is
 * the only correct option once a provider is stateful.
 */
@Module({
  imports: [
    IdentityModule,
    OrderStateModule,
    PaymentsModule,
    NotificationsModule,
    PromotionsModule,
    ReviewsModule,
    LoyaltyModule,
    SupportModule,
    AnalyticsModule,
    // Phase 22: exported RestaurantService/RestaurantProfileService,
    // RestaurantAvailabilityService, and MenuCategoryService/MenuItemService
    // respectively, so the new admin content/menu controllers reuse the
    // exact same owner-side business logic instead of duplicating it.
    RestaurantsModule,
    AvailabilityModule,
    MenuModule,
  ],
  controllers: [
    AdminRestaurantsController,
    AdminRestaurantContentController,
    AdminRestaurantMenuController,
    AdminUploadController,
    AdminUsersController,
    AdminOrdersController,
    AdminPaymentsController,
    AdminOperationsController,
    AdminAuditController,
    AdminOverviewController,
    AdminPromotionsController,
    AdminReviewsController,
    AdminLoyaltyController,
    AdminSupportController,
  ],
  providers: [
    AdminQueryRepository,
    RestaurantRepository,
    RestaurantStateService,
    AdminRestaurantContentService,
    AdminUserService,
    AdminOrderService,
    AdminReviewService,
    AdminLoyaltyService,
    AdminSupportService,
    ReconciliationIssueRepository,
    NotificationRepository,
  ],
})
export class AdminModule {}
