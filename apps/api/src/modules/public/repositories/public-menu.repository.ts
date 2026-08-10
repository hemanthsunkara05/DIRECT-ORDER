import { Inject, Injectable } from '@nestjs/common';
import type { MenuCategory, MenuItem } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

/**
 * Read-only, unauthenticated menu access — always filters to
 * `isActive: true, archivedAt: null`. Unavailable-but-active items ARE
 * included (with `isAvailable: false` visible in the response) rather
 * than hidden, so the public page can render them as sold-out instead
 * of making them disappear (docs/14-acceptance-criteria.md, Phase 7:
 * "unavailable items cannot be added" implies they are still shown).
 */
@Injectable()
export class PublicMenuRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listCategories(restaurantId: string): Promise<MenuCategory[]> {
    return this.prisma.menuCategory.findMany({
      where: { restaurantId, isActive: true, archivedAt: null },
      orderBy: { displayOrder: 'asc' },
    });
  }

  async listItems(restaurantId: string): Promise<MenuItem[]> {
    return this.prisma.menuItem.findMany({
      where: { restaurantId, isActive: true, archivedAt: null },
      orderBy: { displayOrder: 'asc' },
    });
  }
}
