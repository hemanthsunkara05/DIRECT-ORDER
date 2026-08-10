import { Module } from '@nestjs/common';
import { PublicModule } from '../public/public.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { OrderStateModule } from './order-state.module.js';
import { CustomerRepository } from './repositories/customer.repository.js';
import { CartRepository } from './repositories/cart.repository.js';
import { CartService } from './services/cart.service.js';
import { CheckoutService } from './services/checkout.service.js';
import { OrderTrackingService } from './services/order-tracking.service.js';
import { OrderExpiryScheduler } from './services/order-expiry.scheduler.js';
import { CartController } from './controllers/cart.controller.js';
import { CheckoutController } from './controllers/checkout.controller.js';
import { OrderTrackingController } from './controllers/order-tracking.controller.js';

/**
 * Phase 9 (Orders, checkout, payments). Imports PublicModule (cart/
 * checkout validation and pricing) and PaymentsModule (the
 * `PaymentProvider`, `MockPaymentProvider`, `PaymentVerificationService`
 * CheckoutService/OrderTrackingController need) — see
 * `order-state.module.ts` for why this isn't circular.
 * `OrderExpiryScheduler` is listed as a provider but injected nowhere:
 * Nest still instantiates it and calls its `OnModuleInit` hook, which
 * is all it needs to start its own in-process timer (same
 * self-starting shape as `OutboxService`).
 */
@Module({
  imports: [OrderStateModule, PublicModule, PaymentsModule],
  controllers: [CartController, CheckoutController, OrderTrackingController],
  providers: [
    CustomerRepository,
    CartRepository,
    CartService,
    CheckoutService,
    OrderTrackingService,
    OrderExpiryScheduler,
  ],
})
export class OrdersModule {}
