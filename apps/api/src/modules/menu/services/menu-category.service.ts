import { Inject, Injectable } from '@nestjs/common';
import type { MenuCategory } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { ConflictError, NotFoundError } from '../../../platform/errors/app-error.js';
import { MenuCategoryRepository } from '../repositories/menu-category.repository.js';
import type { ReorderInput } from '../dto/reorder.dto.js';

export interface CreateCategoryInput {
  name: string;
  description?: string;
}

export interface UpdateCategoryInput {
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

/**
 * Category CRUD, archiving, and bulk reordering. Archiving a category
 * does NOT cascade to its items — an item's own `isActive`/`isAvailable`
 * are managed independently (MenuItemService), and how an archived
 * category's still-active items should render is a public-menu concern
 * that belongs to Phase 7, not this one.
 */
@Injectable()
export class MenuCategoryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MenuCategoryRepository) private readonly categories: MenuCategoryRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(restaurantId: string): Promise<MenuCategory[]> {
    return this.categories.list(restaurantId);
  }

  async create(
    restaurantId: string,
    actorId: string,
    input: CreateCategoryInput,
  ): Promise<MenuCategory> {
    await this.assertNameAvailable(restaurantId, input.name);

    const existing = await this.categories.list(restaurantId);
    const displayOrder =
      existing.length === 0 ? 0 : Math.max(...existing.map((c) => c.displayOrder)) + 1;

    const category = await this.categories.create(restaurantId, {
      name: input.name,
      description: input.description,
      displayOrder,
    });

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'MENU_CATEGORY_CREATED',
      entityType: 'MenuCategory',
      entityId: category.id,
      restaurantId,
      after: { name: category.name },
    });

    return category;
  }

  async update(
    restaurantId: string,
    actorId: string,
    categoryId: string,
    input: UpdateCategoryInput,
  ): Promise<MenuCategory> {
    const existing = await this.categories.findById(restaurantId, categoryId);
    if (!existing) {
      throw new NotFoundError('Menu category not found.');
    }
    if (input.name && input.name.toLowerCase() !== existing.name.toLowerCase()) {
      await this.assertNameAvailable(restaurantId, input.name);
    }

    const updated = await this.categories.update(restaurantId, categoryId, input);
    if (!updated) {
      throw new NotFoundError('Menu category not found.');
    }

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'MENU_CATEGORY_UPDATED',
      entityType: 'MenuCategory',
      entityId: categoryId,
      restaurantId,
      before: { name: existing.name },
      after: input,
    });

    return (await this.categories.findById(restaurantId, categoryId))!;
  }

  async archive(restaurantId: string, actorId: string, categoryId: string): Promise<void> {
    const existing = await this.categories.findById(restaurantId, categoryId);
    if (!existing) {
      throw new NotFoundError('Menu category not found.');
    }

    const archived = await this.categories.archive(restaurantId, categoryId);
    if (!archived) {
      throw new NotFoundError('Menu category not found.');
    }

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'MENU_CATEGORY_ARCHIVED',
      entityType: 'MenuCategory',
      entityId: categoryId,
      restaurantId,
    });
  }

  /**
   * All entries validated against the caller's own tenant BEFORE any
   * write happens, so an id from another restaurant (or a typo'd id)
   * fails the whole batch — the previous order is left completely
   * intact rather than partially applied (docs/14-acceptance-criteria.md,
   * Phase 6). The writes themselves run inside one `$transaction` as a
   * second layer of atomicity for a real database.
   */
  async reorder(restaurantId: string, actorId: string, input: ReorderInput): Promise<void> {
    const existing = await this.categories.list(restaurantId, { includeArchived: true });
    const existingIds = new Set(existing.map((c) => c.id));
    for (const item of input.items) {
      if (!existingIds.has(item.id)) {
        throw new NotFoundError(`Menu category ${item.id} not found.`);
      }
    }

    await this.prisma.$transaction(
      input.items.map((item) =>
        this.prisma.menuCategory.updateMany({
          where: { id: item.id, restaurantId },
          data: { displayOrder: item.displayOrder },
        }),
      ),
    );

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'MENU_CATEGORIES_REORDERED',
      entityType: 'MenuCategory',
      restaurantId,
      after: { count: input.items.length },
    });
  }

  private async assertNameAvailable(restaurantId: string, name: string): Promise<void> {
    const clash = await this.categories.findActiveByName(restaurantId, name);
    if (clash) {
      throw new ConflictError(`A category named "${name}" already exists.`);
    }
  }
}
