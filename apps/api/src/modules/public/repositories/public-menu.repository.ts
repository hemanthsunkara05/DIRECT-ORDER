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

  /**
   * Deliberately unfiltered by `isActive`/`archivedAt`/`isAvailable` —
   * cart validation (Phase 8) needs to tell "this item is archived/
   * unavailable" apart from "this item id never existed at all", which
   * requires seeing the row regardless of its current state.
   */
  async findByIds(restaurantId: string, itemIds: string[]): Promise<MenuItem[]> {
    if (itemIds.length === 0) return [];
    return this.prisma.menuItem.findMany({
      where: { restaurantId, id: { in: itemIds } },
    });
  }
}
