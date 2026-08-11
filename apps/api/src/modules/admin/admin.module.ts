import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { OrderStateModule } from '../orders/order-state.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ReconciliationIssueRepository } from '../payments/repositories/reconciliation-issue.repository.js';
import { RestaurantRepository } from '../restaurants/repositories/restaurant.repository.js';
import { NotificationRepository } from '../notifications/repositories/notification.repository.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { AdminQueryRepository } from './repositories/admin-query.repository.js';
import { RestaurantStateService } from './services/restaurant-state.service.js';
import { AdminUserService } from './services/admin-user.service.js';
import { AdminOrderService } from './services/admin-order.service.js';
import { AdminRestaurantsController } from './controllers/admin-restaurants.controller.js';
import { AdminUsersController } from './controllers/admin-users.controller.js';
import { AdminOrdersController } from './controllers/admin-orders.controller.js';
import { AdminPaymentsController } from './controllers/admin-payments.controller.js';
import { AdminOperationsController } from './controllers/admin-operations.controller.js';
import { AdminAuditController } from './controllers/admin-audit.controller.js';
import { AdminOverviewController } from './controllers/admin-overview.controller.js';
import { AdminPromotionsController } from './controllers/admin-promotions.controller.js';

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
  ],
  controllers: [
    AdminRestaurantsController,
    AdminUsersController,
    AdminOrdersController,
    AdminPaymentsController,
    AdminOperationsController,
    AdminAuditController,
    AdminOverviewController,
    AdminPromotionsController,
  ],
  providers: [
    AdminQueryRepository,
    RestaurantRepository,
    RestaurantStateService,
    AdminUserService,
    AdminOrderService,
    ReconciliationIssueRepository,
    NotificationRepository,
  ],
})
export class AdminModule {}
