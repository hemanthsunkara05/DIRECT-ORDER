import { Inject, Injectable } from '@nestjs/common';
import type { MenuCategory } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export interface CreateMenuCategoryInput {
  name: string;
  description?: string;
  displayOrder: number;
}

export interface UpdateMenuCategoryInput {
  name?: string;
  description?: string | null;
  displayOrder?: number;
  isActive?: boolean;
}

/**
 * Tenant-scoped per the Phase 2 pattern (TenantScopedRepository — see
 * RestaurantStaffRepository for the reference implementation). Categories
 * are never hard-deleted, only archived (`archivedAt` set) — see the
 * MenuCategory model doc comment in schema.prisma.
 */
@Injectable()
export class MenuCategoryRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async create(restaurantId: string, input: CreateMenuCategoryInput): Promise<MenuCategory> {
    return this.prisma.menuCategory.create({
      data: this.withTenant(restaurantId, {
        name: input.name,
        description: input.description,
        displayOrder: input.displayOrder,
      }),
    });
  }

  async findById(restaurantId: string, categoryId: string): Promise<MenuCategory | null> {
    return this.prisma.menuCategory.findFirst({
      where: this.withTenant(restaurantId, { id: categoryId }),
    });
  }

  /** Case-insensitive so "Starters" and "starters" can't coexist — a friendlier bar than the domain model strictly requires, cheap to enforce here. */
  async findActiveByName(restaurantId: string, name: string): Promise<MenuCategory | null> {
    return this.prisma.menuCategory.findFirst({
      where: this.withTenant(restaurantId, {
        archivedAt: null,
        name: { equals: name, mode: 'insensitive' as const },
      }),
    });
  }

  async list(
    restaurantId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<MenuCategory[]> {
    return this.prisma.menuCategory.findMany({
      where: this.withTenant(restaurantId, options.includeArchived ? {} : { archivedAt: null }),
      orderBy: { displayOrder: 'asc' },
    });
  }

  /**
   * `updateMany` rather than `update({ where: { id } })` — same
   * IDOR-shaped reason as RestaurantStaffRepository.updateRole: a
   * single-record `update`'s `where` only accepts unique-key filters, so
   * a composite `{ id, restaurantId }` would silently collapse to `id`
   * alone and drop tenant scoping.
   */
  async update(
    restaurantId: string,
    categoryId: string,
    data: UpdateMenuCategoryInput,
  ): Promise<boolean> {
    const result = await this.prisma.menuCategory.updateMany({
      where: this.withTenant(restaurantId, { id: categoryId }),
      data,
    });
    return result.count > 0;
  }

  async archive(restaurantId: string, categoryId: string): Promise<boolean> {
    const result = await this.prisma.menuCategory.updateMany({
      where: this.withTenant(restaurantId, { id: categoryId }),
      data: { archivedAt: new Date(), isActive: false },
    });
    return result.count > 0;
  }

  async setDisplayOrder(
    restaurantId: string,
    categoryId: string,
    displayOrder: number,
  ): Promise<boolean> {
    const result = await this.prisma.menuCategory.updateMany({
      where: this.withTenant(restaurantId, { id: categoryId }),
      data: { displayOrder },
    });
    return result.count > 0;
  }
}
