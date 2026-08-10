import { Inject, Injectable } from '@nestjs/common';
import type { DietaryTag, MenuItem } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export interface CreateMenuItemInput {
  categoryId: string;
  name: string;
  description?: string;
  priceMinor: bigint;
  imageUrl?: string;
  dietaryTag: DietaryTag;
  displayOrder: number;
}

export interface UpdateMenuItemInput {
  categoryId?: string;
  name?: string;
  description?: string | null;
  priceMinor?: bigint;
  imageUrl?: string | null;
  dietaryTag?: DietaryTag;
  displayOrder?: number;
  isActive?: boolean;
  isAvailable?: boolean;
}

/** Tenant-scoped per the Phase 2 pattern — see MenuCategoryRepository for the parallel implementation. */
@Injectable()
export class MenuItemRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async create(restaurantId: string, input: CreateMenuItemInput): Promise<MenuItem> {
    return this.prisma.menuItem.create({
      data: this.withTenant(restaurantId, {
        categoryId: input.categoryId,
        name: input.name,
        description: input.description,
        priceMinor: input.priceMinor,
        imageUrl: input.imageUrl,
        dietaryTag: input.dietaryTag,
        displayOrder: input.displayOrder,
      }),
    });
  }

  async findById(restaurantId: string, itemId: string): Promise<MenuItem | null> {
    return this.prisma.menuItem.findFirst({
      where: this.withTenant(restaurantId, { id: itemId }),
    });
  }

  async list(
    restaurantId: string,
    options: { categoryId?: string; includeArchived?: boolean } = {},
  ): Promise<MenuItem[]> {
    return this.prisma.menuItem.findMany({
      where: this.withTenant(restaurantId, {
        ...(options.categoryId ? { categoryId: options.categoryId } : {}),
        ...(options.includeArchived ? {} : { archivedAt: null }),
      }),
      orderBy: { displayOrder: 'asc' },
    });
  }

  /** See MenuCategoryRepository.update for why this is `updateMany`, not `update`. */
  async update(restaurantId: string, itemId: string, data: UpdateMenuItemInput): Promise<boolean> {
    const result = await this.prisma.menuItem.updateMany({
      where: this.withTenant(restaurantId, { id: itemId }),
      data,
    });
    return result.count > 0;
  }

  async archive(restaurantId: string, itemId: string): Promise<boolean> {
    const result = await this.prisma.menuItem.updateMany({
      where: this.withTenant(restaurantId, { id: itemId }),
      data: { archivedAt: new Date(), isActive: false, isAvailable: false },
    });
    return result.count > 0;
  }

  async setAvailability(
    restaurantId: string,
    itemId: string,
    isAvailable: boolean,
  ): Promise<boolean> {
    const result = await this.prisma.menuItem.updateMany({
      where: this.withTenant(restaurantId, { id: itemId }),
      data: { isAvailable },
    });
    return result.count > 0;
  }

  async setDisplayOrder(
    restaurantId: string,
    itemId: string,
    displayOrder: number,
  ): Promise<boolean> {
    const result = await this.prisma.menuItem.updateMany({
      where: this.withTenant(restaurantId, { id: itemId }),
      data: { displayOrder },
    });
    return result.count > 0;
  }

  async countInCategory(restaurantId: string, categoryId: string): Promise<number> {
    return this.prisma.menuItem.count({
      where: this.withTenant(restaurantId, { categoryId, archivedAt: null }),
    });
  }
}
