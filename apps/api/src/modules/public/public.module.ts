import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module.js';
import { PublicRestaurantRepository } from './repositories/public-restaurant.repository.js';
import { PublicMenuRepository } from './repositories/public-menu.repository.js';
import { PublicRestaurantService } from './services/public-restaurant.service.js';
import { PublicRestaurantController } from './controllers/public-restaurant.controller.js';

/**
 * Phase 7. Unauthenticated — no IdentityModule import, no AuthGuard
 * anywhere in this module. Imports AvailabilityModule to reuse
 * `isAcceptingOrders()` rather than re-deriving availability logic.
 */
@Module({
  imports: [AvailabilityModule],
  controllers: [PublicRestaurantController],
  providers: [PublicRestaurantRepository, PublicMenuRepository, PublicRestaurantService],
})
export class PublicModule {}
