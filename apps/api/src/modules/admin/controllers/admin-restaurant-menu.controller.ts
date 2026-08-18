import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ok } from '../../../platform/http/response-envelope.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { CurrentAdmin } from '../../../platform/authorization/current-admin.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CreateCategoryDto } from '../../menu/dto/create-category.dto.js';
import { UpdateCategoryDto } from '../../menu/dto/update-category.dto.js';
import { CreateItemDto } from '../../menu/dto/create-item.dto.js';
import { UpdateItemDto } from '../../menu/dto/update-item.dto.js';
import { ToggleAvailabilityDto } from '../../menu/dto/toggle-availability.dto.js';
import { ReorderDto } from '../../menu/dto/reorder.dto.js';
import { MenuCategoryService } from '../../menu/services/menu-category.service.js';
import { MenuItemService } from '../../menu/services/menu-item.service.js';
import { toPublicCategory } from '../../menu/controllers/menu-category.controller.js';
import { toPublicItem } from '../../menu/controllers/menu-item.controller.js';

/**
 * `/admin/restaurants/:restaurantId/menu*` (Phase 22, docs/06 BR-171).
 * One controller for both category and item routes — a deliberate
 * deviation from the owner side's two-file split; this admin surface is
 * small enough that the extra split isn't pulling its weight. Calls the
 * SAME MenuCategoryService/MenuItemService methods the owner-side
 * tenant-scoped controllers call, actor-attributed as 'ADMIN'. No
 * `@TenantScoped()` — restaurantId comes from the path, not a resolved
 * membership, matching every other admin-only controller in this module.
 */
@Controller('admin/restaurants/:restaurantId/menu')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminRestaurantMenuController {
  constructor(
    @Inject(MenuCategoryService) private readonly categories: MenuCategoryService,
    @Inject(MenuItemService) private readonly items: MenuItemService,
  ) {}

  @Get('categories')
  @Permissions('menu:read')
  @HttpCode(200)
  async listCategories(@Param('restaurantId') restaurantId: string) {
    return ok((await this.categories.list(restaurantId)).map(toPublicCategory));
  }

  @Post('categories')
  @Permissions('menu:write')
  @HttpCode(201)
  async createCategory(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('restaurantId') restaurantId: string,
    @Body() body: unknown,
  ) {
    const input = CreateCategoryDto.parse(body);
    const category = await this.categories.create(
      restaurantId,
      { type: 'ADMIN', id: admin.adminUserId },
      input,
    );
    return ok(toPublicCategory(category));
  }

  @Post('categories/reorder')
  @Permissions('menu:write')
  @HttpCode(200)
  async reorderCategories(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('restaurantId') restaurantId: string,
    @Body() body: unknown,
  ) {
    const input = ReorderDto.parse(body);
    await this.categories.reorder(restaurantId, { type: 'ADMIN', id: admin.adminUserId }, input);
    return ok({ status: 'ok' });
  }

  @Patch('categories/:id')
  @Permissions('menu:write')
  @HttpCode(200)
  async updateCategory(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('restaurantId') restaurantId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = UpdateCategoryDto.parse(body);
    const category = await this.categories.update(
      restaurantId,
      { type: 'ADMIN', id: admin.adminUserId },
      id,
      input,
    );
    return ok(toPublicCategory(category));
  }

  @Delete('categories/:id')
  @Permissions('menu:write')
  @HttpCode(200)
  async archiveCategory(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('restaurantId') restaurantId: string,
    @Param('id') id: string,
  ) {
    await this.categories.archive(restaurantId, { type: 'ADMIN', id: admin.adminUserId }, id);
    return ok({ status: 'ok' });
  }

  @Get('items')
  @Permissions('menu:read')
  @HttpCode(200)
  async listItems(
    @Param('restaurantId') restaurantId: string,
    @Query('categoryId') categoryId?: string,
  ) {
    return ok((await this.items.list(restaurantId, categoryId)).map(toPublicItem));
  }

  @Post('items')
  @Permissions('menu:write')
  @HttpCode(201)
  async createItem(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('restaurantId') restaurantId: string,
    @Body() body: unknown,
  ) {
    const input = CreateItemDto.parse(body);
    const item = await this.items.create(
      restaurantId,
      { type: 'ADMIN', id: admin.adminUserId },
      input,
    );
    return ok(toPublicItem(item));
  }

  @Post('items/reorder')
  @Permissions('menu:write')
  @HttpCode(200)
  async reorderItems(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('restaurantId') restaurantId: string,
    @Body() body: unknown,
  ) {
    const input = ReorderDto.parse(body);
    await this.items.reorder(restaurantId, { type: 'ADMIN', id: admin.adminUserId }, input);
    return ok({ status: 'ok' });
  }

  @Patch('items/:id/availability')
  @Permissions('menu:availability')
  @HttpCode(200)
  async setItemAvailability(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('restaurantId') restaurantId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = ToggleAvailabilityDto.parse(body);
    const item = await this.items.setAvailability(
      restaurantId,
      { type: 'ADMIN', id: admin.adminUserId },
      id,
      input.isAvailable,
    );
    return ok(toPublicItem(item));
  }

  @Patch('items/:id')
  @Permissions('menu:write')
  @HttpCode(200)
  async updateItem(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('restaurantId') restaurantId: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = UpdateItemDto.parse(body);
    const item = await this.items.update(
      restaurantId,
      { type: 'ADMIN', id: admin.adminUserId },
      id,
      input,
    );
    return ok(toPublicItem(item));
  }

  @Delete('items/:id')
  @Permissions('menu:write')
  @HttpCode(200)
  async archiveItem(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('restaurantId') restaurantId: string,
    @Param('id') id: string,
  ) {
    await this.items.archive(restaurantId, { type: 'ADMIN', id: admin.adminUserId }, id);
    return ok({ status: 'ok' });
  }
}
