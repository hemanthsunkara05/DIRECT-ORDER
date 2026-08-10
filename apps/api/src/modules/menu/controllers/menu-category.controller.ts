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
  UseGuards,
} from '@nestjs/common';
import type { MenuCategory, User } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { CreateCategoryDto } from '../dto/create-category.dto.js';
import { UpdateCategoryDto } from '../dto/update-category.dto.js';
import { ReorderDto } from '../dto/reorder.dto.js';
import { MenuCategoryService } from '../services/menu-category.service.js';

/**
 * `/restaurant/menu/categories*` (docs/04-api-specification.md §8.5).
 * Every handler is MANAGER+ (`menu:write`/`menu:read`) — unlike items,
 * categories have no STAFF-permitted action.
 */
@Controller('restaurant/menu/categories')
@UseGuards(AuthGuard, AuthorizationGuard)
export class MenuCategoryController {
  constructor(@Inject(MenuCategoryService) private readonly categories: MenuCategoryService) {}

  @Get()
  @TenantScoped()
  @Permissions('menu:read')
  @HttpCode(200)
  async list(@CurrentTenant() tenant: TenantContext) {
    const categories = await this.categories.list(tenant.restaurantId);
    return ok(categories.map(toPublicCategory));
  }

  @Post()
  @TenantScoped()
  @Permissions('menu:write')
  @HttpCode(201)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = CreateCategoryDto.parse(body);
    const category = await this.categories.create(tenant.restaurantId, user.id, input);
    return ok(toPublicCategory(category));
  }

  @Post('reorder')
  @TenantScoped()
  @Permissions('menu:write')
  @HttpCode(200)
  async reorder(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = ReorderDto.parse(body);
    await this.categories.reorder(tenant.restaurantId, user.id, input);
    return ok({ status: 'ok' });
  }

  @Patch(':id')
  @TenantScoped()
  @Permissions('menu:write')
  @HttpCode(200)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = UpdateCategoryDto.parse(body);
    const category = await this.categories.update(tenant.restaurantId, user.id, id, input);
    return ok(toPublicCategory(category));
  }

  @Delete(':id')
  @TenantScoped()
  @Permissions('menu:write')
  @HttpCode(200)
  async archive(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    await this.categories.archive(tenant.restaurantId, user.id, id);
    return ok({ status: 'ok' });
  }
}

export function toPublicCategory(category: MenuCategory) {
  return {
    id: category.id,
    name: category.name,
    description: category.description,
    displayOrder: category.displayOrder,
    isActive: category.isActive,
    archivedAt: category.archivedAt,
  };
}
