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
import type { MenuItem, User } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { CreateItemDto } from '../dto/create-item.dto.js';
import { UpdateItemDto } from '../dto/update-item.dto.js';
import { ToggleAvailabilityDto } from '../dto/toggle-availability.dto.js';
import { ReorderDto } from '../dto/reorder.dto.js';
import { MenuItemService } from '../services/menu-item.service.js';

/**
 * `/restaurant/menu/items*` (docs/04-api-specification.md §8.5). Every
 * handler is MANAGER+ (`menu:write`/`menu:read`) EXCEPT the availability
 * toggle, which is `menu:availability` — the one menu action STAFF holds
 * (kitchen staff marking an item 86'd needs no manager present).
 */
@Controller('restaurant/menu/items')
@UseGuards(AuthGuard, AuthorizationGuard)
export class MenuItemController {
  constructor(@Inject(MenuItemService) private readonly items: MenuItemService) {}

  @Get()
  @TenantScoped()
  @Permissions('menu:read')
  @HttpCode(200)
  async list(@CurrentTenant() tenant: TenantContext, @Query('categoryId') categoryId?: string) {
    const items = await this.items.list(tenant.restaurantId, categoryId);
    return ok(items.map(toPublicItem));
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
    const input = CreateItemDto.parse(body);
    const item = await this.items.create(tenant.restaurantId, user.id, input);
    return ok(toPublicItem(item));
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
    await this.items.reorder(tenant.restaurantId, user.id, input);
    return ok({ status: 'ok' });
  }

  @Patch(':id/availability')
  @TenantScoped()
  @Permissions('menu:availability')
  @HttpCode(200)
  async setAvailability(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = ToggleAvailabilityDto.parse(body);
    const item = await this.items.setAvailability(
      tenant.restaurantId,
      user.id,
      id,
      input.isAvailable,
    );
    return ok(toPublicItem(item));
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
    const input = UpdateItemDto.parse(body);
    const item = await this.items.update(tenant.restaurantId, user.id, id, input);
    return ok(toPublicItem(item));
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
    await this.items.archive(tenant.restaurantId, user.id, id);
    return ok({ status: 'ok' });
  }
}

export function toPublicItem(item: MenuItem) {
  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    description: item.description,
    priceMinor: item.priceMinor.toString(),
    currency: item.currency,
    imageUrl: item.imageUrl,
    isAvailable: item.isAvailable,
    isActive: item.isActive,
    displayOrder: item.displayOrder,
    dietaryTag: item.dietaryTag,
    archivedAt: item.archivedAt,
  };
}
