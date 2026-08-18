import { Inject, Injectable } from '@nestjs/common';
import type { Restaurant, RestaurantAddress, RestaurantBranding } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import type { AuditActor } from '../../../platform/audit/audit.types.js';
import { getOrCreateUnclaimedPlaceholder } from '../../../platform/unclaimed-listings.js';
import { RestaurantService } from '../../restaurants/services/restaurant.service.js';
import { RestaurantProfileService } from '../../restaurants/services/restaurant-profile.service.js';
import type { AdminCreateRestaurantInput } from '../dto/admin-create-restaurant.dto.js';

export interface AdminCreatedRestaurant {
  restaurant: Restaurant;
  address: RestaurantAddress | null;
  branding: RestaurantBranding | null;
}

/**
 * Admin-side restaurant creation (Phase 22, docs/06 BR-165-BR-168). Owner
 * resolution + placeholder find-or-create is the one genuinely new piece
 * of business logic this phase adds — everything else here is a thin
 * pass-through to RestaurantService/RestaurantProfileService, the exact
 * same services the owner-side tenant-scoped controllers call. There is
 * deliberately no new "Prospect" concept: an admin-created restaurant
 * with no resolvable owner is created exactly like every other unclaimed
 * listing (owned only by the shared placeholder account), so it shows up
 * in the existing `GET /admin/restaurants/unclaimed` worklist and is
 * claimable through the existing, unmodified `POST /restaurants/claim`
 * with zero further reconciliation logic.
 */
@Injectable()
export class AdminRestaurantContentService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RestaurantService) private readonly restaurants: RestaurantService,
    @Inject(RestaurantProfileService) private readonly profile: RestaurantProfileService,
  ) {}

  async create(
    adminUserId: string,
    input: AdminCreateRestaurantInput,
  ): Promise<AdminCreatedRestaurant> {
    const actor: AuditActor = { type: 'ADMIN', id: adminUserId };
    const { ownerId, isPlaceholder } = await this.resolveOwner(input.ownerEmail, input.ownerPhone);

    const restaurant = await this.restaurants.createRestaurant(
      ownerId,
      {
        name: input.name,
        slug: input.slug,
        description: input.description,
        phone: input.phone,
        email: input.email,
        timezone: input.timezone,
      },
      actor,
      { skipOwnershipGuard: isPlaceholder },
    );

    let address: RestaurantAddress | null = null;
    if (input.address) {
      ({ address } = await this.profile.updateProfile(restaurant.id, actor, {
        address: input.address,
      }));
    }

    const branding = input.branding
      ? await this.profile.updateBranding(restaurant.id, actor, input.branding)
      : null;

    return { restaurant, address, branding };
  }

  /**
   * A supplied `ownerEmail`/`ownerPhone` that doesn't match an existing
   * account falls back to the placeholder rather than erroring — an
   * admin mid-call often doesn't know whether an owner has already
   * registered an account of their own. Falling back also means every
   * admin-created restaurant with no resolvable owner is structurally
   * identical to every other unclaimed listing (docs/06 BR-166) — it
   * needs no special handling anywhere else in the codebase.
   */
  private async resolveOwner(
    ownerEmail?: string,
    ownerPhone?: string,
  ): Promise<{ ownerId: string; isPlaceholder: boolean }> {
    if (ownerEmail || ownerPhone) {
      const found = ownerEmail
        ? await this.prisma.user.findUnique({ where: { email: ownerEmail } })
        : await this.prisma.user.findUnique({ where: { phone: ownerPhone! } });
      if (found) {
        return { ownerId: found.id, isPlaceholder: false };
      }
    }
    const placeholder = await getOrCreateUnclaimedPlaceholder(this.prisma);
    return { ownerId: placeholder.id, isPlaceholder: true };
  }
}
