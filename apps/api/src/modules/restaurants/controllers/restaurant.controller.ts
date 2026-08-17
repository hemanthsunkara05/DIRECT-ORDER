import { Body, Controller, Get, HttpCode, Inject, Patch, Post, UseGuards } from '@nestjs/common';
import type {
  Restaurant,
  RestaurantAddress,
  RestaurantBranding,
  RestaurantSettings,
  User,
} from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { UpdateProfileDto } from '../dto/update-profile.dto.js';
import { UpsertBrandingDto } from '../dto/upsert-branding.dto.js';
import { UpsertSettingsDto } from '../dto/upsert-settings.dto.js';
import { RestaurantProfileService } from '../services/restaurant-profile.service.js';
import { toPublicRestaurant } from './restaurants.controller.js';

/**
 * `/restaurant/*` — every route here is tenant-scoped, resolved from
 * the caller's membership (docs/04-api-specification.md §8.5). Every
 * handler pairs `@TenantScoped()` with `@Permissions(...)`, enforced by
 * `AuthorizationGuard`, which — per its own doc comment — must run
 * after `AuthGuard`: both are applied here, in that order.
 */
@Controller('restaurant')
@UseGuards(AuthGuard, AuthorizationGuard)
export class RestaurantController {
  constructor(
    @Inject(RestaurantProfileService) private readonly profile: RestaurantProfileService,
  ) {}

  @Get('profile')
  @TenantScoped()
  @Permissions('restaurant:read')
  @HttpCode(200)
  async getProfile(@CurrentTenant() tenant: TenantContext) {
    const { restaurant, address } = await this.profile.getProfile(tenant.restaurantId);
    return ok({ ...toOwnerRestaurant(restaurant), address: toPublicAddress(address) });
  }

  @Patch('profile')
  @TenantScoped()
  @Permissions('restaurant:update')
  @HttpCode(200)
  async updateProfile(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = UpdateProfileDto.parse(body);
    const { restaurant, address } = await this.profile.updateProfile(
      tenant.restaurantId,
      user.id,
      input,
    );
    return ok({ ...toOwnerRestaurant(restaurant), address: toPublicAddress(address) });
  }

  @Get('branding')
  @TenantScoped()
  @Permissions('restaurant:read')
  @HttpCode(200)
  async getBranding(@CurrentTenant() tenant: TenantContext) {
    return ok(toPublicBranding(await this.profile.getBranding(tenant.restaurantId)));
  }

  @Patch('branding')
  @TenantScoped()
  @Permissions('restaurant:branding')
  @HttpCode(200)
  async updateBranding(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = UpsertBrandingDto.parse(body);
    const updated = await this.profile.updateBranding(tenant.restaurantId, user.id, input);
    return ok(toPublicBranding(updated));
  }

  @Get('settings')
  @TenantScoped()
  @Permissions('restaurant:settings')
  @HttpCode(200)
  async getSettings(@CurrentTenant() tenant: TenantContext) {
    return ok(toPublicSettings(await this.profile.getSettings(tenant.restaurantId)));
  }

  @Patch('settings')
  @TenantScoped()
  @Permissions('restaurant:settings')
  @HttpCode(200)
  async updateSettings(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = UpsertSettingsDto.parse(body);
    const updated = await this.profile.updateSettings(tenant.restaurantId, user.id, input);
    return ok(toPublicSettings(updated));
  }

  @Post('onboarding/submit')
  @TenantScoped()
  @Permissions('restaurant:update')
  @HttpCode(200)
  async submitOnboarding(@CurrentTenant() tenant: TenantContext, @CurrentUser() user: User) {
    const restaurant = await this.profile.submitOnboarding(tenant.restaurantId, user.id);
    return ok(toOwnerRestaurant(restaurant));
  }
}

/**
 * `toPublicRestaurant()` plus the approval-lifecycle fields (Phase 21a)
 * — `submittedAt`/`decidedAt`/`rejectionReason` are internal moderation
 * state, never included in `toPublicRestaurant()` itself since that
 * function is shared with `public-restaurant.controller.ts`'s anonymous
 * customer-facing endpoint. Every call site in this file is owner-
 * facing and tenant-scoped, so it's safe here specifically.
 */
function toOwnerRestaurant(restaurant: Restaurant) {
  return {
    ...toPublicRestaurant(restaurant),
    submittedAt: restaurant.submittedAt,
    decidedAt: restaurant.decidedAt,
    rejectionReason: restaurant.rejectionReason,
  };
}

function toPublicAddress(address: RestaurantAddress | null) {
  if (!address) return null;
  return {
    line1: address.line1,
    line2: address.line2,
    locality: address.locality,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    latitude: address.latitude,
    longitude: address.longitude,
    landmark: address.landmark,
  };
}

function toPublicBranding(branding: RestaurantBranding | null) {
  if (!branding) return null;
  return {
    logoUrl: branding.logoUrl,
    coverImageUrl: branding.coverImageUrl,
    themePrimaryColor: branding.themePrimaryColor,
    themeAccentColor: branding.themeAccentColor,
    tagline: branding.tagline,
  };
}

function toPublicSettings(settings: RestaurantSettings | null) {
  if (!settings) return null;
  return {
    minOrderAmountMinor: settings.minOrderAmountMinor.toString(),
    packagingFeeMinor: settings.packagingFeeMinor.toString(),
    deliveryFeeMode: settings.deliveryFeeMode,
    deliveryFeeFlatMinor: settings.deliveryFeeFlatMinor.toString(),
    acceptsOnlinePayment: settings.acceptsOnlinePayment,
    autoAcceptOrders: settings.autoAcceptOrders,
    notificationEmails: settings.notificationEmails,
    notificationPhones: settings.notificationPhones,
  };
}
