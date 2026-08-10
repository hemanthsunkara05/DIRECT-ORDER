import { Inject, Injectable } from '@nestjs/common';
import type { Restaurant, RestaurantStaff } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';

export type MembershipWithRestaurant = RestaurantStaff & { restaurant: Restaurant };

/**
 * The mirror image of RestaurantStaffRepository (modules/restaurants):
 * that one is tenant-scoped, always keyed by a restaurantId already
 * known. This one answers the question that has to come BEFORE a
 * tenant is known at all — "which restaurant(s) does this user belong
 * to?" — so it is deliberately a plain repository, not a
 * TenantScopedRepository. Lives in the platform layer, not
 * modules/restaurants, because AuthorizationGuard (a cross-cutting
 * platform concern every future domain module's routes depend on)
 * needs it without importing a domain module.
 */
@Injectable()
export class RestaurantMembershipRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Every ACTIVE membership for this user, across every restaurant. */
  async findActiveByUser(userId: string): Promise<RestaurantStaff[]> {
    return this.prisma.restaurantStaff.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: { joinedAt: 'asc' },
    });
  }

  /**
   * Same as findActiveByUser, but with each membership's Restaurant
   * attached — for surfaces that display membership info (GET /auth/me)
   * rather than ones that only need it to resolve a tenant.
   */
  async findActiveByUserWithRestaurant(userId: string): Promise<MembershipWithRestaurant[]> {
    return this.prisma.restaurantStaff.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: { joinedAt: 'asc' },
      include: { restaurant: true },
    });
  }

  /**
   * A specific (user, restaurant) membership, regardless of status —
   * callers that need to distinguish "no such membership" from "a
   * DISABLED membership" (different failure modes, docs/05 §9.4) check
   * `.status` themselves rather than this method silently filtering.
   */
  async find(userId: string, restaurantId: string): Promise<RestaurantStaff | null> {
    return this.prisma.restaurantStaff.findUnique({
      where: { userId_restaurantId: { userId, restaurantId } },
    });
  }
}
