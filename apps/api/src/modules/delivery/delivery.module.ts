import { Module } from '@nestjs/common';
import type { Env } from '../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../platform/config/config.module.js';
import { OrderStateModule } from '../orders/order-state.module.js';
import { WebhookEventRepository } from '../payments/repositories/webhook-event.repository.js';
import { DeliveryRepository } from './repositories/delivery.repository.js';
import { MockDeliveryProvider } from './providers/mock-delivery.provider.js';
import { UberDirectProvider } from './providers/uber-direct.provider.js';
import { DELIVERY_PROVIDER, type DeliveryProvider } from './providers/delivery-provider.port.js';
import { DeliveryDispatchService } from './services/delivery-dispatch.service.js';
import { DeliveryWebhookService } from './services/delivery-webhook.service.js';
import { DeliveryWebhookController } from './controllers/delivery-webhook.controller.js';

/**
 * `MockDeliveryProvider` is always registered as a concrete provider
 * (not just bound behind `DELIVERY_PROVIDER`) — same reason
 * `MockPaymentProvider` is in `PaymentsModule`: its test-control methods
 * (`forceOutcome`, `advanceStatus`) aren't part of the `DeliveryProvider`
 * interface, and tests need the concrete class directly regardless of
 * which implementation `DELIVERY_PROVIDER` currently resolves to.
 *
 * `WebhookEventRepository` is provided again here rather than imported
 * from `PaymentsModule` — it is a thin, stateless wrapper around
 * `PrismaService` (no per-instance state of its own), so a second Nest-
 * managed instance is exactly as correct as sharing PaymentsModule's,
 * without adding a cross-module export/import just for one repository
 * class. Both instances read and write the very same `webhook_events`
 * table; that table, not the class instance, is the shared resource.
 *
 * Imports `OrderStateModule` (not the full `OrdersModule`) for
 * `OrderRepository`/`OrderStateService` — same split-module shape that
 * module already exists to enable (see its own doc comment): OrdersModule
 * imports DeliveryModule (for dispatch-on-ready and surfacing delivery
 * info in order responses), so DeliveryModule importing OrdersModule
 * back would be circular.
 */
@Module({
  imports: [OrderStateModule],
  controllers: [DeliveryWebhookController],
  providers: [
    DeliveryRepository,
    WebhookEventRepository,
    MockDeliveryProvider,
    UberDirectProvider,
    {
      provide: DELIVERY_PROVIDER,
      useFactory: (
        env: Env,
        mock: MockDeliveryProvider,
        uberDirect: UberDirectProvider,
      ): DeliveryProvider => (env.DELIVERY_PROVIDER === 'uber_direct' ? uberDirect : mock),
      inject: [APP_CONFIG, MockDeliveryProvider, UberDirectProvider],
    },
    DeliveryDispatchService,
    DeliveryWebhookService,
  ],
  exports: [DELIVERY_PROVIDER, MockDeliveryProvider, DeliveryDispatchService, DeliveryRepository],
})
export class DeliveryModule {}
