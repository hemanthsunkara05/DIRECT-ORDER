import { Inject, Injectable } from '@nestjs/common';
import type { DietaryTag, MenuItem } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import type { AuditActor } from '../../../platform/audit/audit.types.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { MenuCategoryRepository } from '../repositories/menu-category.repository.js';
import { MenuItemRepository } from '../repositories/menu-item.repository.js';
import type { ReorderInput } from '../dto/reorder.dto.js';

export interface CreateItemInput {
  categoryId: string;
  name: string;
  description?: string;
  priceMinor: bigint;
  imageUrl?: string;
  dietaryTag?: DietaryTag;
}

export interface UpdateItemInput {
  categoryId?: string;
  name?: string;
  description?: string | null;
  priceMinor?: bigint;
  imageUrl?: string | null;
  dietaryTag?: DietaryTag;
  isActive?: boolean;
}

/**
 * Item CRUD, archiving, availability toggling, and bulk reordering.
 * Items are never hard-deleted (schema.prisma's MenuItem doc comment) —
 * "delete" here always means `archive()`, which sets `archivedAt` and
 * also flips `isActive`/`isAvailable` off so an archived item can never
 * be orderable again through either flag.
 */
@Injectable()
export class MenuItemService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MenuItemRepository) private readonly items: MenuItemRepository,
    @Inject(MenuCategoryRepository) private readonly categories: MenuCategoryRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(restaurantId: string, categoryId?: string): Promise<MenuItem[]> {
    return this.items.list(restaurantId, { categoryId });
  }

  async create(restaurantId: string, actor: AuditActor, input: CreateItemInput): Promise<MenuItem> {
    await this.assertCategoryUsable(restaurantId, input.categoryId);

    const siblingCount = await this.items.countInCategory(restaurantId, input.categoryId);

    const item = await this.items.create(restaurantId, {
      categoryId: input.categoryId,
      name: input.name,
      description: input.description,
      priceMinor: input.priceMinor,
      imageUrl: input.imageUrl,
      dietaryTag: input.dietaryTag ?? 'UNKNOWN',
      displayOrder: siblingCount,
    });

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'MENU_ITEM_CREATED',
      entityType: 'MenuItem',
      entityId: item.id,
      restaurantId,
      after: { name: item.name, priceMinor: item.priceMinor.toString() },
    });

    return item;
  }

  async update(
    restaurantId: string,
    actor: AuditActor,
    itemId: string,
    input: UpdateItemInput,
  ): Promise<MenuItem> {
    const existing = await this.items.findById(restaurantId, itemId);
    if (!existing) {
      throw new NotFoundError('Menu item not found.');
    }
    if (input.categoryId && input.categoryId !== existing.categoryId) {
      await this.assertCategoryUsable(restaurantId, input.categoryId);
    }

    const updated = await this.items.update(restaurantId, itemId, input);
    if (!updated) {
      throw new NotFoundError('Menu item not found.');
    }

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'MENU_ITEM_UPDATED',
      entityType: 'MenuItem',
      entityId: itemId,
      restaurantId,
      before: { name: existing.name, priceMinor: existing.priceMinor.toString() },
      after: { ...input, priceMinor: input.priceMinor?.toString() },
    });

    return (await this.items.findById(restaurantId, itemId))!;
  }

  async archive(restaurantId: string, actor: AuditActor, itemId: string): Promise<void> {
    const existing = await this.items.findById(restaurantId, itemId);
    if (!existing) {
      throw new NotFoundError('Menu item not found.');
    }

    const archived = await this.items.archive(restaurantId, itemId);
    if (!archived) {
      throw new NotFoundError('Menu item not found.');
    }

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'MENU_ITEM_ARCHIVED',
      entityType: 'MenuItem',
      entityId: itemId,
      restaurantId,
    });
  }

  /**
   * The one menu action STAFF (not just MANAGER/OWNER) can take
   * (docs/04-api-specification.md §8.5) — kitchen staff running out of
   * an ingredient need to 86 an item without needing a manager present.
   */
  async setAvailability(
    restaurantId: string,
    actor: AuditActor,
    itemId: string,
    isAvailable: boolean,
  ): Promise<MenuItem> {
    const existing = await this.items.findById(restaurantId, itemId);
    if (!existing) {
      throw new NotFoundError('Menu item not found.');
    }

    const updated = await this.items.setAvailability(restaurantId, itemId, isAvailable);
    if (!updated) {
      throw new NotFoundError('Menu item not found.');
    }

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'MENU_ITEM_AVAILABILITY_CHANGED',
      entityType: 'MenuItem',
      entityId: itemId,
      restaurantId,
      before: { isAvailable: existing.isAvailable },
      after: { isAvailable },
    });

    return (await this.items.findById(restaurantId, itemId))!;
  }

  /** See MenuCategoryService.reorder — same validate-before-write, single-transaction approach. */
  async reorder(restaurantId: string, actor: AuditActor, input: ReorderInput): Promise<void> {
    const existing = await this.items.list(restaurantId, { includeArchived: true });
    const existingIds = new Set(existing.map((i) => i.id));
    for (const item of input.items) {
      if (!existingIds.has(item.id)) {
        throw new NotFoundError(`Menu item ${item.id} not found.`);
      }
    }

    await this.prisma.$transaction(
      input.items.map((item) =>
        this.prisma.menuItem.updateMany({
          where: { id: item.id, restaurantId },
          data: { displayOrder: item.displayOrder },
        }),
      ),
    );

    await this.audit.record({
      actorType: actor.type,
      actorId: actor.id,
      action: 'MENU_ITEMS_REORDERED',
      entityType: 'MenuItem',
      restaurantId,
      after: { count: input.items.length },
    });
  }

  private async assertCategoryUsable(restaurantId: string, categoryId: string): Promise<void> {
    const category = await this.categories.findById(restaurantId, categoryId);
    if (!category) {
      throw new NotFoundError('Menu category not found.');
    }
    if (category.archivedAt) {
      throw new ValidationError('Cannot add or move an item into an archived category.');
    }
  }
}
