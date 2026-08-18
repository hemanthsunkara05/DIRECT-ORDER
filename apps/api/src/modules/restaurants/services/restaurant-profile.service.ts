import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditLog,
  Restaurant,
  RestaurantAddress,
  RestaurantBranding,
  RestaurantSettings,
} from '@prisma/client';
import { AuditService } from '../../../platform/audit/audit.service.js';
import type { AuditActor } from '../../../platform/audit/audit.types.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';
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
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async getProfile(restaurantId: string): Promise<RestaurantWithAddress> {
    const restaurant = await this.requireRestaurant(restaurantId);
    const address = await this.addresses.find(restaurantId);
    return { restaurant, address };
  }

  async updateProfile(
    restaurantId: string,
    actor: AuditActor,
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
      actorType: actor.type,
      actorId: actor.id,
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
    actor: AuditActor,
    input: UpsertRestaurantBrandingInput,
  ): Promise<RestaurantBranding> {
    const updated = await this.branding.upsert(restaurantId, input);
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
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
    actor: AuditActor,
    input: UpsertRestaurantSettingsInput,
  ): Promise<RestaurantSettings> {
    const updated = await this.settings.upsert(restaurantId, input);
    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
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
   * a full pickup address) before allowing DRAFT/REJECTED →
   * PENDING_APPROVAL (docs/03-state-machines.md §7.5: "onboarding
   * submitted" / "resubmitted", both legal edges). Branding and
   * settings stay optional — a restaurant can go live with defaults and
   * refine its look later. Also covers Phase 21a's resubmit path — the
   * same endpoint (`POST /restaurant/onboarding/submit`) simply keeps
   * working once the guard accepts `REJECTED`, rather than a separate
   * `/resubmit` route calling identical logic.
   */
  async submitOnboarding(restaurantId: string, actor: AuditActor): Promise<Restaurant> {
    const restaurant = await this.requireRestaurant(restaurantId);
    // Captured as a primitive before `update()` runs below — see
    // `RestaurantStateService.transition()`'s identical doc comment: the
    // in-memory test fake mutates rows in place, so `restaurant` and the
    // row `update()` writes are the same object reference, and reading
    // `restaurant.status` again afterwards would observe the new value.
    const fromStatus = restaurant.status;
    const address = await this.addresses.find(restaurantId);

    if (!address) {
      throw new ConflictError('A pickup address is required before onboarding can be submitted.');
    }
    if (fromStatus !== 'DRAFT' && fromStatus !== 'REJECTED') {
      throw new ConflictError(`Onboarding cannot be submitted from status ${fromStatus}.`);
    }

    const updated = await this.restaurants.update(restaurantId, {
      status: 'PENDING_APPROVAL',
      onboardingStatus: 'COMPLETED',
      submittedAt: new Date(),
      rejectionReason: null,
    });

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'RESTAURANT_ONBOARDING_SUBMITTED',
      entityType: 'Restaurant',
      entityId: restaurantId,
      restaurantId,
      before: { status: fromStatus },
      after: { status: updated.status, onboardingStatus: updated.onboardingStatus },
    });

    // After commit, never inside it (docs/03-state-machines.md universal
    // rule 4) — this method has no transaction to defer past, so the
    // insert simply follows the write directly.
    await this.outbox.record(
      'RESTAURANT_SUBMITTED_FOR_APPROVAL',
      { restaurantId: updated.id, restaurantName: updated.name },
      updated.id,
    );

    return updated;
  }

  /**
   * Owner-facing "an admin changed something" surface (Phase 22, docs/06
   * BR-172) — deliberately strips actorId/before/after: the owner learns
   * that Direct-Order made a change and roughly what, not which admin or
   * the raw diff. Backed entirely by the existing audit read path, no
   * schema change.
   */
  async getRecentAdminActivity(restaurantId: string, limit = 20): Promise<AuditLog[]> {
    const page = await this.audit.findByRestaurant(restaurantId, { actorType: 'ADMIN', limit });
    return page.items;
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
