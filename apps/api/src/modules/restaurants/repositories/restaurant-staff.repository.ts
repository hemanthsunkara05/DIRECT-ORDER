import { Inject, Injectable } from '@nestjs/common';
import type { RestaurantStaff, RestaurantStaffRole } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export interface CreateRestaurantStaffInput {
  userId: string;
  role: RestaurantStaffRole;
  invitedByUserId?: string;
}

/**
 * The reference implementation of TenantScopedRepository (Phase 2). Every
 * public method takes `restaurantId` as its first parameter — see
 * tenant-scoped.repository.type-test.ts for the compile-time proof that
 * omitting it is a type error, not just a convention.
 *
 * Deliberately minimal for Phase 2: create/read only, enough for the
 * seed script and this phase's tests. Invitation flow, role changes,
 * and disable/re-enable belong to Phase 5 (restaurant onboarding),
 * which extends this repository rather than replacing it.
 */
@Injectable()
export class RestaurantStaffRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async create(restaurantId: string, input: CreateRestaurantStaffInput): Promise<RestaurantStaff> {
    return this.prisma.restaurantStaff.create({
      data: this.withTenant(restaurantId, {
        userId: input.userId,
        role: input.role,
        invitedByUserId: input.invitedByUserId,
      }),
    });
  }

  async findById(restaurantId: string, staffId: string): Promise<RestaurantStaff | null> {
    return this.prisma.restaurantStaff.findFirst({
      where: this.withTenant(restaurantId, { id: staffId }),
    });
  }

  async findActiveOwners(restaurantId: string): Promise<RestaurantStaff[]> {
    return this.prisma.restaurantStaff.findMany({
      where: this.withTenant(restaurantId, { role: 'OWNER' as const, status: 'ACTIVE' as const }),
    });
  }

  async countActiveOwners(restaurantId: string): Promise<number> {
    return this.prisma.restaurantStaff.count({
      where: this.withTenant(restaurantId, { role: 'OWNER' as const, status: 'ACTIVE' as const }),
    });
  }

  async list(restaurantId: string, options: { limit?: number } = {}): Promise<RestaurantStaff[]> {
    return this.prisma.restaurantStaff.findMany({
      where: this.withTenant(restaurantId, {}),
      orderBy: { joinedAt: 'desc' },
      take: Math.min(options.limit ?? 20, 100),
    });
  }
}
