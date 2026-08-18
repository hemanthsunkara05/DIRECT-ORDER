import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { OperatingHoursRepository } from './repositories/operating-hours.repository.js';
import { SpecialHoursRepository } from './repositories/special-hours.repository.js';
import { ClosurePeriodRepository } from './repositories/closure-period.repository.js';
import { AvailabilityService } from './availability.service.js';
import { RestaurantAvailabilityService } from './services/restaurant-availability.service.js';
import { HoursController } from './controllers/hours.controller.js';
import { ClosuresController } from './controllers/closures.controller.js';
import { RestaurantAvailabilityController } from './controllers/restaurant-availability.controller.js';

/**
 * Phase 7. `AvailabilityService` (the `isAcceptingOrders()` authority)
 * is exported so PublicModule can reuse it without duplicating the
 * precedence logic — the whole point of a single authority is that
 * nothing else re-implements it.
 */
@Module({
  imports: [IdentityModule],
  controllers: [HoursController, ClosuresController, RestaurantAvailabilityController],
  providers: [
    OperatingHoursRepository,
    SpecialHoursRepository,
    ClosurePeriodRepository,
    AvailabilityService,
    RestaurantAvailabilityService,
  ],
  // Phase 22: RestaurantAvailabilityService exported so AdminModule can
  // reuse the exact hours-management logic the owner-side controllers
  // call, rather than duplicating it.
  exports: [AvailabilityService, OperatingHoursRepository, RestaurantAvailabilityService],
})
export class AvailabilityModule {}
