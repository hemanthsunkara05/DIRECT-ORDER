import { Module } from '@nestjs/common';
import type { Env } from '../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../platform/config/config.module.js';
import { OrderStateModule } from '../orders/order-state.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CustomerRepository } from '../orders/repositories/customer.repository.js';
import { PaymentRepository } from '../payments/repositories/payment.repository.js';
import { RestaurantStaffRepository } from '../restaurants/repositories/restaurant-staff.repository.js';
import { NotificationRepository } from './repositories/notification.repository.js';
import { NotificationPreferenceRepository } from './repositories/notification-preference.repository.js';
import {
  SMS_CHANNEL_ADAPTER,
  WHATSAPP_CHANNEL_ADAPTER,
  EMAIL_CHANNEL_ADAPTER,
  type NotificationChannelAdapter,
} from './channels/notification-channel.port.js';
import { ConsoleSmsProvider } from './channels/console-sms.provider.js';
import { Msg91SmsProvider } from './channels/msg91-sms.provider.js';
import { ConsoleWhatsappProvider } from './channels/console-whatsapp.provider.js';
import { GupshupWhatsappProvider } from './channels/gupshup-whatsapp.provider.js';
import { ConsoleEmailProvider } from './channels/console-email.provider.js';
import { ResendEmailProvider } from './channels/resend-email.provider.js';
import { NotificationCatalogue } from './services/notification-catalogue.js';
import { NotificationPreferenceService } from './services/notification-preference.service.js';
import { NotificationDispatchService } from './services/notification-dispatch.service.js';
import { NotificationRetryScheduler } from './services/notification-retry.scheduler.js';
import { NotificationCenterController } from './controllers/notification-center.controller.js';

/**
 * Phase 12 (Notifications). Imports `OrderStateModule` for
 * `OrderRepository` (the catalogue re-reads order context rather than
 * trusting event payloads — docs/07 §11.2) and `IdentityModule` for
 * `AuthGuard`/`CurrentUser` (`/me/notifications*`). Does NOT import
 * `OrdersModule`/`PaymentsModule`/`DeliveryModule`/`RestaurantsModule`
 * directly — `CustomerRepository`, `PaymentRepository`, and
 * `RestaurantStaffRepository` are each provided again here, the exact
 * same "thin, stateless, PrismaService-backed — a second Nest-managed
 * instance is exactly as correct as sharing another module's" call
 * `DeliveryModule` already made for `WebhookEventRepository` in Phase
 * 11 (see that module's own doc comment). This keeps the dependency
 * graph a strict DAG rooted at each domain's own state-holding module
 * rather than pulling in entire unrelated domain modules (controllers,
 * services, permissions) just to reach one repository class.
 *
 * `NotificationDispatchService` registers itself with the global
 * `OutboxService` in its own `onModuleInit()` — see that method's doc
 * comment for why this is a runtime hook, not a module import, in
 * either direction.
 */
@Module({
  imports: [OrderStateModule, IdentityModule],
  controllers: [NotificationCenterController],
  providers: [
    NotificationRepository,
    NotificationPreferenceRepository,
    CustomerRepository,
    PaymentRepository,
    RestaurantStaffRepository,
    ConsoleSmsProvider,
    Msg91SmsProvider,
    ConsoleWhatsappProvider,
    GupshupWhatsappProvider,
    ConsoleEmailProvider,
    ResendEmailProvider,
    {
      provide: SMS_CHANNEL_ADAPTER,
      useFactory: (
        env: Env,
        console_: ConsoleSmsProvider,
        msg91: Msg91SmsProvider,
      ): NotificationChannelAdapter => (env.SMS_PROVIDER === 'msg91' ? msg91 : console_),
      inject: [APP_CONFIG, ConsoleSmsProvider, Msg91SmsProvider],
    },
    {
      provide: WHATSAPP_CHANNEL_ADAPTER,
      useFactory: (
        env: Env,
        console_: ConsoleWhatsappProvider,
        gupshup: GupshupWhatsappProvider,
      ): NotificationChannelAdapter => (env.WHATSAPP_PROVIDER === 'gupshup' ? gupshup : console_),
      inject: [APP_CONFIG, ConsoleWhatsappProvider, GupshupWhatsappProvider],
    },
    {
      provide: EMAIL_CHANNEL_ADAPTER,
      useFactory: (
        env: Env,
        console_: ConsoleEmailProvider,
        resend: ResendEmailProvider,
      ): NotificationChannelAdapter => (env.EMAIL_PROVIDER === 'resend' ? resend : console_),
      inject: [APP_CONFIG, ConsoleEmailProvider, ResendEmailProvider],
    },
    // Reused directly (not re-provided) from their owning modules where
    // possible; the three below are the deliberate exceptions this
    // module's own doc comment explains.
    NotificationCatalogue,
    NotificationPreferenceService,
    NotificationDispatchService,
    NotificationRetryScheduler,
  ],
})
export class NotificationsModule {}
