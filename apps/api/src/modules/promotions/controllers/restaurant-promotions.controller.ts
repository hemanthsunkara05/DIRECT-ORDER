import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Promotion, User } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { NotFoundError } from '../../../platform/errors/app-error.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { PromotionCreateDto } from '../dto/promotion-create.dto.js';
import { PromotionUpdateDto } from '../dto/promotion-update.dto.js';
import { PromotionRepository } from '../repositories/promotion.repository.js';

/**
 * `/restaurant/promotions` (docs/04-api-specification.md §8.5, MANAGER).
 * `restaurantId` is never read from the request body — always the
 * caller's own tenant, the same "ownerId in the body is ignored"
 * pattern Phase 5 established for restaurant creation. This is the
 * actual mechanism behind "a restaurant cannot create or modify
 * platform-wide promotions" (docs/14-acceptance-criteria.md): there is
 * no code path here that can ever produce `restaurantId: null`, and
 * `update()` 404s (not 403) on a promotion that isn't this tenant's own
 * — including every platform-wide one — matching this codebase's
 * established 403-vs-404 tenant-isolation convention (a wrong-tenant
 * resource looks identical to a nonexistent one).
 */
@Controller('restaurant/promotions')
@UseGuards(AuthGuard, AuthorizationGuard)
export class RestaurantPromotionsController {
  constructor(@Inject(PromotionRepository) private readonly promotions: PromotionRepository) {}

  @Get()
  @TenantScoped()
  @Permissions('promotions:read')
  @HttpCode(200)
  async list(@CurrentTenant() tenant: TenantContext) {
    const rows = await this.promotions.listForRestaurant(tenant.restaurantId);
    return ok(rows.map(toPublicPromotion));
  }

  @Post()
  @TenantScoped()
  @Permissions('promotions:write')
  @HttpCode(201)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = PromotionCreateDto.parse(body);
    const created = await this.promotions.create({
      ...input,
      restaurantId: tenant.restaurantId,
      createdByUserId: user.id,
    });
    return ok(toPublicPromotion(created));
  }

  @Patch(':id')
  @TenantScoped()
  @Permissions('promotions:write')
  @HttpCode(200)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = PromotionUpdateDto.parse(body);
    const existing = await this.promotions.findByIdForRestaurant(id, tenant.restaurantId);
    if (!existing) {
      throw new NotFoundError('Promotion not found.');
    }
    const updated = await this.promotions.update(id, input);
    return ok(toPublicPromotion(updated));
  }
}

export function toPublicPromotion(promotion: Promotion) {
  return {
    id: promotion.id,
    restaurantId: promotion.restaurantId,
    code: promotion.code,
    name: promotion.name,
    type: promotion.type,
    value: promotion.value,
    minOrderMinor: promotion.minOrderMinor?.toString() ?? null,
    maxDiscountMinor: promotion.maxDiscountMinor?.toString() ?? null,
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    usageLimitTotal: promotion.usageLimitTotal,
    usageLimitPerCustomer: promotion.usageLimitPerCustomer,
    firstOrderOnly: promotion.firstOrderOnly,
    isActive: promotion.isActive,
    createdAt: promotion.createdAt,
  };
}
