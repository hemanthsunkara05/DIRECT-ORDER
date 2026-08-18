import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { RestaurantRepository } from './repositories/restaurant.repository.js';
import { RestaurantAddressRepository } from './repositories/restaurant-address.repository.js';
import { RestaurantBrandingRepository } from './repositories/restaurant-branding.repository.js';
import { RestaurantSettingsRepository } from './repositories/restaurant-settings.repository.js';
import { RestaurantStaffRepository } from './repositories/restaurant-staff.repository.js';
import { StaffInvitationRepository } from './repositories/staff-invitation.repository.js';
import { RestaurantService } from './services/restaurant.service.js';
import { RestaurantProfileService } from './services/restaurant-profile.service.js';
import { StaffManagementService } from './services/staff-management.service.js';
import { UploadService } from './uploads/upload.service.js';
import { STORAGE_PORT } from './uploads/storage.port.js';
import { S3StorageAdapter } from './uploads/s3-storage.adapter.js';
import { RestaurantsController } from './controllers/restaurants.controller.js';
import { RestaurantController } from './controllers/restaurant.controller.js';
import { StaffController } from './controllers/staff.controller.js';
import { UploadController } from './controllers/upload.controller.js';
import { AcceptInvitationController } from './controllers/accept-invitation.controller.js';

/**
 * Phase 5 (restaurant onboarding and profile). Imports IdentityModule
 * for `AuthGuard` — every controller here applies
 * `@UseGuards(AuthGuard, AuthorizationGuard)` (AuthorizationGuard comes
 * from the `@Global()` AuthorizationModule, so it needs no import here).
 */
@Module({
  imports: [IdentityModule],
  controllers: [
    RestaurantsController,
    RestaurantController,
    StaffController,
    UploadController,
    AcceptInvitationController,
  ],
  providers: [
    RestaurantRepository,
    RestaurantAddressRepository,
    RestaurantBrandingRepository,
    RestaurantSettingsRepository,
    RestaurantStaffRepository,
    StaffInvitationRepository,
    RestaurantService,
    RestaurantProfileService,
    StaffManagementService,
    UploadService,
    { provide: STORAGE_PORT, useClass: S3StorageAdapter },
  ],
  // Phase 22: AdminModule needs RestaurantService/RestaurantProfileService
  // to build the admin-authorized content-management surface on top of
  // the SAME owner-side logic, rather than duplicating it.
  exports: [RestaurantService, RestaurantProfileService],
})
export class RestaurantsModule {}
