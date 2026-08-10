import { Inject, Injectable } from '@nestjs/common';
import type {
  Restaurant,
  RestaurantAddress,
  RestaurantBranding,
  RestaurantSettings,
} from '@prisma/client';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { ConflictError, NotFoundError } from '../../../platform/errors/app-error.js';
import { RestaurantRepository } from '../repositories/restaurant.repository.js';
import {
  RestaurantAddressRepository,
  type UpsertRestaurantAddressInput,
} from '../repositories/restaurant-address.repository.js';
import {
  RestaurantBrandingRepository,
  type UpsertRestaurantBrandingInput,
} from '../repositories/restaurant-branding.repository.js';
import {
  RestaurantSettingsRepository,
  type UpsertRestaurantSettingsInput,
} from '../repositories/restaurant-settings.repository.js';

export interface UpdateProfileInput {
  name?: string;
  description?: string;
  phone?: string;
  email?: string;
  timezone?: string;
  address?: UpsertRestaurantAddressInput;
}

export interface RestaurantWithAddress {
  restaurant: Restaurant;
  address: RestaurantAddress | null;
}

/**
 * Profile, address, branding, settings, and onboarding submission all
 * operate on the same tenant aggregate and share the same audit/
 * not-found handling, so they live in one service rather than four —
 * splitting further would just be four near-identical wrappers around
 * their respective repositories.
 */
@Injectable()
export class RestaurantProfileService {
  constructor(
    @Inject(RestaurantRepository) private readonly restaurants: RestaurantRepository,
    @Inject(RestaurantAddressRepository) private readonly addresses: RestaurantAddressRepository,
    @Inject(RestaurantBrandingRepository) private readonly branding: RestaurantBrandingRepository,
    @Inject(RestaurantSettingsRepository) private readonly settings: RestaurantSettingsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async getProfile(restaurantId: string): Promise<RestaurantWithAddress> {
    const restaurant = await this.requireRestaurant(restaurantId);
    const address = await this.addresses.find(restaurantId);
    return { restaurant, address };
  }

  async updateProfile(
    restaurantId: string,
    actorId: string,
    input: UpdateProfileInput,
  ): Promise<RestaurantWithAddress> {
    const before = await this.requireRestaurant(restaurantId);
    const { address: addressInput, ...profileFields } = input;

    const restaurant =
      Object.keys(profileFields).length > 0
        ? await this.restaurants.update(restaurantId, profileFields)
        : before;
    const address = addressInput
      ? await this.addresses.upsert(restaurantId, addressInput)
      : await this.addresses.find(restaurantId);

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'RESTAURANT_PROFILE_UPDATED',
      entityType: 'Restaurant',
      entityId: restaurantId,
      restaurantId,
      before: {
        name: before.name,
        description: before.description,
        phone: before.phone,
        email: before.email,
      },
      after: profileFields,
    });

    return { restaurant, address };
  }

  async getBranding(restaurantId: string): Promise<RestaurantBranding | null> {
    return this.branding.find(restaurantId);
  }

  async updateBranding(
    restaurantId: string,
    actorId: string,
    input: UpsertRestaurantBrandingInput,
  ): Promise<RestaurantBranding> {
    const updated = await this.branding.upsert(restaurantId, input);
    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'RESTAURANT_BRANDING_UPDATED',
      entityType: 'RestaurantBranding',
      entityId: updated.id,
      restaurantId,
    });
    return updated;
  }

  async getSettings(restaurantId: string): Promise<RestaurantSettings | null> {
    return this.settings.find(restaurantId);
  }

  async updateSettings(
    restaurantId: string,
    actorId: string,
    input: UpsertRestaurantSettingsInput,
  ): Promise<RestaurantSettings> {
    const updated = await this.settings.upsert(restaurantId, input);
    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'RESTAURANT_SETTINGS_UPDATED',
      entityType: 'RestaurantSettings',
      entityId: updated.id,
      restaurantId,
    });
    return updated;
  }

  /**
   * The backend-authoritative completion gate (Phase 5 acceptance
   * criteria: "onboarding completion is determined by the backend;
   * clearing browser storage does not change it"). Requires the
   * minimum viable profile (name — already required at creation — and
   * a full pickup address) before allowing DRAFT → PENDING_APPROVAL
   * (docs/03-state-machines.md §7.5: "onboarding submitted"). Branding
   * and settings stay optional — a restaurant can go live with defaults
   * and refine its look later.
   */
  async submitOnboarding(restaurantId: string, actorId: string): Promise<Restaurant> {
    const restaurant = await this.requireRestaurant(restaurantId);
    const address = await this.addresses.find(restaurantId);

    if (!address) {
      throw new ConflictError('A pickup address is required before onboarding can be submitted.');
    }
    if (restaurant.status !== 'DRAFT') {
      throw new ConflictError(`Onboarding cannot be submitted from status ${restaurant.status}.`);
    }

    const updated = await this.restaurants.update(restaurantId, {
      status: 'PENDING_APPROVAL',
      onboardingStatus: 'COMPLETED',
    });

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'RESTAURANT_ONBOARDING_SUBMITTED',
      entityType: 'Restaurant',
      entityId: restaurantId,
      restaurantId,
      after: { status: updated.status, onboardingStatus: updated.onboardingStatus },
    });

    return updated;
  }

  private async requireRestaurant(restaurantId: string): Promise<Restaurant> {
    const restaurant = await this.restaurants.findById(restaurantId);
    if (!restaurant) {
      // Cannot actually happen for a caller reached via AuthorizationGuard
      // (the tenant it resolved came from a real membership row, which
      // has a foreign key to this same Restaurant) — guards against the
      // type only, not a real runtime path.
      throw new NotFoundError();
    }
    return restaurant;
  }
}
