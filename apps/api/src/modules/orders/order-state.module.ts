import { Module } from '@nestjs/common';
import { OrderRepository } from './repositories/order.repository.js';
import { OrderStateService } from './services/order-state.service.js';

/**
 * Split out of OrdersModule deliberately: PaymentsModule needs
 * `OrderStateService` (PaymentVerificationService drives PENDING_PAYMENT
 * → PLACED/PAYMENT_FAILED on a verified provider signal), and
 * OrdersModule needs `PAYMENT_PROVIDER` from PaymentsModule
 * (CheckoutService creates the provider payment intent) — importing
 * each other's full module would be circular. Both import this small,
 * dependency-free module instead; neither imports the other.
 */
@Module({
  providers: [OrderRepository, OrderStateService],
  exports: [OrderRepository, OrderStateService],
})
export class OrderStateModule {}
