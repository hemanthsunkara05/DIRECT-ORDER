import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ok } from '../../../platform/http/response-envelope.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { CurrentAdmin } from '../../../platform/authorization/current-admin.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { AdminCreateRestaurantDto } from '../dto/admin-create-restaurant.dto.js';
import { UpdateProfileDto } from '../../restaurants/dto/update-profile.dto.js';
import { UpsertBrandingDto } from '../../restaurants/dto/upsert-branding.dto.js';
import { SetHoursDto } from '../../availability/dto/set-hours.dto.js';
import { AdminRestaurantContentService } from '../services/admin-restaurant-content.service.js';
import { RestaurantProfileService } from '../../restaurants/services/restaurant-profile.service.js';
import { RestaurantAvailabilityService } from '../../availability/services/restaurant-availability.service.js';
import {
  toOwnerRestaurant,
  toPublicAddress,
  toPublicBranding,
} from '../../restaurants/controllers/restaurant.controller.js';
import { toPublicHoursRow } from '../../availability/controllers/hours.controller.js';

/**
 * `/admin/restaurants*` content-management surface (Phase 22, docs/06
 * BR-165-BR-172). A SECOND controller on the same base path as
 * AdminRestaurantsController — fully supported by Nest, no route here
 * overlaps with that one. No `@TenantScoped()` anywhere: this is an
 * admin-only surface, mirroring AdminRestaurantsController's own shape
 * exactly (permission-gated, target restaurant id from `@Param`,
 * `@CurrentAdmin()` for the actor). Every writer method threads
 * `actorType: 'ADMIN'` through to the SAME service methods the owner-side
 * tenant-scoped controllers call — no business logic is duplicated here.
 */
@Controller('admin/restaurants')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminRestaurantContentController {
  constructor(
    @Inject(AdminRestaurantContentService)
    private readonly content: AdminRestaurantContentService,
    @Inject(RestaurantProfileService) private readonly profile: RestaurantProfileService,
    @Inject(RestaurantAvailabilityService)
    private readonly availability: RestaurantAvailabilityService,
  ) {}

  @Post()
  @Permissions('restaurant:create')
  @HttpCode(201)
  async create(@CurrentAdmin() admin: { adminUserId: string }, @Body() body: unknown) {
    const input = AdminCreateRestaurantDto.parse(body);
    const { restaurant, address, branding } = await this.content.create(admin.adminUserId, input);
    return ok({
      ...toOwnerRestaurant(restaurant),
      address: toPublicAddress(address),
      branding: toPublicBranding(branding),
    });
  }

  @Get(':id/profile')
  @Permissions('restaurant:read')
  @HttpCode(200)
  async getProfile(@Param('id') id: string) {
    const { restaurant, address } = await this.profile.getProfile(id);
    return ok({ ...toOwnerRestaurant(restaurant), address: toPublicAddress(address) });
  }

  @Patch(':id/profile')
  @Permissions('restaurant:admin_edit')
  @HttpCode(200)
  async updateProfile(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = UpdateProfileDto.parse(body);
    const { restaurant, address } = await this.profile.updateProfile(
      id,
      { type: 'ADMIN', id: admin.adminUserId },
      input,
    );
    return ok({ ...toOwnerRestaurant(restaurant), address: toPublicAddress(address) });
  }

  @Get(':id/branding')
  @Permissions('restaurant:read')
  @HttpCode(200)
  async getBranding(@Param('id') id: string) {
    return ok(toPublicBranding(await this.profile.getBranding(id)));
  }

  @Patch(':id/branding')
  @Permissions('restaurant:admin_edit')
  @HttpCode(200)
  async updateBranding(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = UpsertBrandingDto.parse(body);
    const updated = await this.profile.updateBranding(
      id,
      { type: 'ADMIN', id: admin.adminUserId },
      input,
    );
    return ok(toPublicBranding(updated));
  }

  @Get(':id/hours')
  @Permissions('restaurant:read')
  @HttpCode(200)
  async getHours(@Param('id') id: string) {
    const rows = await this.availability.getHours(id);
    return ok(rows.map(toPublicHoursRow));
  }

  @Put(':id/hours')
  @Permissions('restaurant:admin_edit')
  @HttpCode(200)
  async setHours(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = SetHoursDto.parse(body);
    const rows = await this.availability.setHours(
      id,
      { type: 'ADMIN', id: admin.adminUserId },
      input,
    );
    return ok(rows.map(toPublicHoursRow));
  }

  /**
   * Admin-authorized equivalent of the owner's `POST
   * /restaurant/onboarding/submit` (docs/06 BR-165) — an admin completing
   * concierge setup still submits through the same gate an owner would,
   * and the restaurant still requires a SEPARATE, explicit approval
   * action (`POST :id/approve` on AdminRestaurantsController, unchanged
   * since Phase 21a) before going ACTIVE. This endpoint only ever reaches
   * PENDING_APPROVAL — Phase 21's human-review gate is not bypassed for
   * admin-created restaurants, even though the same admin can immediately
   * follow up with an approve call if they hold `restaurant:approve` too.
   */
  @Post(':id/submit-for-approval')
  @Permissions('restaurant:admin_edit')
  @HttpCode(200)
  async submitForApproval(@CurrentAdmin() admin: { adminUserId: string }, @Param('id') id: string) {
    const restaurant = await this.profile.submitOnboarding(id, {
      type: 'ADMIN',
      id: admin.adminUserId,
    });
    return ok(toOwnerRestaurant(restaurant));
  }
}
