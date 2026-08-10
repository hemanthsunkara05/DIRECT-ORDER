import { Module } from '@nestjs/common';
import type { Env } from '../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../platform/config/config.module.js';
import { OrderStateModule } from '../orders/order-state.module.js';
import { PaymentRepository } from './repositories/payment.repository.js';
import { RefundRepository } from './repositories/refund.repository.js';
import { WebhookEventRepository } from './repositories/webhook-event.repository.js';
import { ReconciliationIssueRepository } from './repositories/reconciliation-issue.repository.js';
import { MockPaymentProvider } from './providers/mock-payment.provider.js';
import { RazorpayPaymentProvider } from './providers/razorpay-payment.provider.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from './providers/payment-provider.port.js';
import { ReconciliationService } from './services/reconciliation.service.js';
import { PaymentVerificationService } from './services/payment-verification.service.js';
import { RefundService } from './services/refund.service.js';
import { WebhookService } from './services/webhook.service.js';
import { WebhookController } from './controllers/webhook.controller.js';

/**
 * `MockPaymentProvider` is always registered as a concrete provider
 * (not just bound behind `PAYMENT_PROVIDER`) — OrdersModule's
 * simulate-payment endpoint needs the concrete class directly (its
 * `simulatePaymentOutcome()` method isn't part of the `PaymentProvider`
 * interface; see that provider's own doc comment), independent of
 * which implementation `PAYMENT_PROVIDER` currently resolves to.
 */
@Module({
  imports: [OrderStateModule],
  controllers: [WebhookController],
  providers: [
    PaymentRepository,
    RefundRepository,
    WebhookEventRepository,
    ReconciliationIssueRepository,
    MockPaymentProvider,
    RazorpayPaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (
        env: Env,
        mock: MockPaymentProvider,
        razorpay: RazorpayPaymentProvider,
      ): PaymentProvider => (env.PAYMENT_PROVIDER === 'razorpay' ? razorpay : mock),
      inject: [APP_CONFIG, MockPaymentProvider, RazorpayPaymentProvider],
    },
    ReconciliationService,
    PaymentVerificationService,
    RefundService,
    WebhookService,
  ],
  exports: [
    PAYMENT_PROVIDER,
    MockPaymentProvider,
    PaymentVerificationService,
    RefundService,
    PaymentRepository,
  ],
})
export class PaymentsModule {}
