import { Inject, Injectable } from '@nestjs/common';
import type {
  Restaurant,
  RestaurantAddress,
  RestaurantBranding,
  RestaurantSettings,
} from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export type RestaurantWithPublicRelations = Restaurant & {
  address: RestaurantAddress | null;
  branding: RestaurantBranding | null;
  settings: RestaurantSettings | null;
};

/**
 * Deliberately NOT a `TenantScopedRepository` — there is no authenticated
 * tenant here, the slug IS the lookup key, and that's the entire point
 * of this being the public surface. Every other repository in this
 * codebase requires a `restaurantId` the caller already has; this one
 * exists specifically to resolve one from an unauthenticated request.
 */
@Injectable()
export class PublicRestaurantRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findBySlug(slug: string): Promise<RestaurantWithPublicRelations | null> {
    return this.prisma.restaurant.findUnique({
      where: { slug },
      include: { address: true, branding: true, settings: true },
    });
  }

  /** Phase 9: CartService/CheckoutService already have a `restaurantId` (from a persisted Cart), not a slug. */
  async findById(id: string): Promise<RestaurantWithPublicRelations | null> {
    return this.prisma.restaurant.findUnique({
      where: { id },
      include: { address: true, branding: true, settings: true },
    });
  }
}
