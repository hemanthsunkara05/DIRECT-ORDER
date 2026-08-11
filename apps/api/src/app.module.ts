import { Module } from '@nestjs/common';
import type { Env } from './platform/config/env.schema.js';
import { PlatformModule } from './platform/platform.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { RestaurantsModule } from './modules/restaurants/restaurants.module.js';
import { MenuModule } from './modules/menu/menu.module.js';
import { AvailabilityModule } from './modules/availability/availability.module.js';
import { PublicModule } from './modules/public/public.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { DeliveryModule } from './modules/delivery/delivery.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { PromotionsModule } from './modules/promotions/promotions.module.js';
import { AdminModule } from './modules/admin/admin.module.js';

@Module({})
export class AppModule {
  static forRoot(env: Env) {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(env),
        IdentityModule,
        RestaurantsModule,
        MenuModule,
        AvailabilityModule,
        PublicModule,
        PaymentsModule,
        DeliveryModule,
        OrdersModule,
        NotificationsModule,
        PromotionsModule,
        AdminModule,
      ],
    };
  }
}
