import { Inject, Injectable } from '@nestjs/common';
import type { RestaurantStaff, RestaurantStaffRole, User } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export interface CreateRestaurantStaffInput {
  userId: string;
  role: RestaurantStaffRole;
  invitedByUserId?: string;
}

export type RestaurantStaffWithUser = RestaurantStaff & {
  user: Pick<User, 'id' | 'fullName' | 'email' | 'phone'>;
};

/**
 * The reference implementation of TenantScopedRepository (Phase 2). Every
 * public method takes `restaurantId` as its first parameter — see
 * tenant-scoped.repository.type-test.ts for the compile-time proof that
 * omitting it is a type error, not just a convention.
 *
 * Extended in Phase 5 with role changes and disable/re-enable — the
 * last-active-OWNER protection (docs/01-domain-model.md §5.2) is
 * enforced by StaffManagementService, one layer up, not here: this
 * repository stays a thin, honest reflection of what the database will
 * actually do with a given write.
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

  async listWithUser(
    restaurantId: string,
    options: { limit?: number } = {},
  ): Promise<RestaurantStaffWithUser[]> {
    return this.prisma.restaurantStaff.findMany({
      where: this.withTenant(restaurantId, {}),
      orderBy: { joinedAt: 'desc' },
      take: Math.min(options.limit ?? 20, 100),
      include: { user: { select: { id: true, fullName: true, email: true, phone: true } } },
    });
  }

  /**
   * `updateMany` rather than `update({ where: { id } })` — Prisma's
   * single-record `update` only accepts a unique-key where clause,
   * which would mean looking the row up by `id` alone and silently
   * dropping the `restaurantId` filter (exactly the IDOR class
   * TenantScopedRepository exists to prevent). `updateMany` accepts an
   * arbitrary filter, so the tenant check is real, and `count === 0`
   * tells the caller "no such staff row in this tenant" (→ 404) instead
   * of falsely reporting success.
   */
  async updateRole(
    restaurantId: string,
    staffId: string,
    role: RestaurantStaffRole,
  ): Promise<boolean> {
    const result = await this.prisma.restaurantStaff.updateMany({
      where: this.withTenant(restaurantId, { id: staffId }),
      data: { role },
    });
    return result.count > 0;
  }

  async setStatus(
    restaurantId: string,
    staffId: string,
    status: 'ACTIVE' | 'DISABLED',
  ): Promise<boolean> {
    const result = await this.prisma.restaurantStaff.updateMany({
      where: this.withTenant(restaurantId, { id: staffId }),
      data: { status, disabledAt: status === 'DISABLED' ? new Date() : null },
    });
    return result.count > 0;
  }
}
