import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { PublicModule } from '../public/public.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { OrderStateModule } from './order-state.module.js';
import { CustomerRepository } from './repositories/customer.repository.js';
import { CartRepository } from './repositories/cart.repository.js';
import { CartService } from './services/cart.service.js';
import { CheckoutService } from './services/checkout.service.js';
import { OrderTrackingService } from './services/order-tracking.service.js';
import { OrderExpiryScheduler } from './services/order-expiry.scheduler.js';
import { RestaurantOrderService } from './services/restaurant-order.service.js';
import { OrderStreamService } from './services/order-stream.service.js';
import { CartController } from './controllers/cart.controller.js';
import { CheckoutController } from './controllers/checkout.controller.js';
import { OrderTrackingController } from './controllers/order-tracking.controller.js';
import { RestaurantOrderController } from './controllers/restaurant-order.controller.js';

/**
 * Phase 9 (Orders, checkout, payments) + Phase 10 (restaurant order
 * management). Imports PublicModule (cart/checkout validation and
 * pricing), PaymentsModule (`PaymentProvider`, `MockPaymentProvider`,
 * `PaymentVerificationService`, and — Phase 10 — `RefundService` for
 * reject-triggered refunds), and IdentityModule (`AuthGuard`, needed by
 * `RestaurantOrderController`'s `@UseGuards(AuthGuard,
 * AuthorizationGuard)`, same as every other authenticated
 * restaurant-facing controller — see restaurants.module.ts) — see
 * `order-state.module.ts` for why importing PaymentsModule isn't
 * circular. `OrderExpiryScheduler` is listed as a provider but injected
 * nowhere: Nest still instantiates it and calls its `OnModuleInit`
 * hook, which is all it needs to start its own in-process timer (same
 * self-starting shape as `OutboxService`).
 */
@Module({
  imports: [OrderStateModule, PublicModule, PaymentsModule, IdentityModule],
  controllers: [
    CartController,
    CheckoutController,
    OrderTrackingController,
    RestaurantOrderController,
  ],
  providers: [
    CustomerRepository,
    CartRepository,
    CartService,
    CheckoutService,
    OrderTrackingService,
    OrderExpiryScheduler,
    RestaurantOrderService,
    OrderStreamService,
  ],
})
export class OrdersModule {}
