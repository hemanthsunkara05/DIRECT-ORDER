import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { CurrentAdmin } from '../../../platform/authorization/current-admin.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { PromotionCreateDto } from '../../promotions/dto/promotion-create.dto.js';
import { PromotionUpdateDto } from '../../promotions/dto/promotion-update.dto.js';
import { PromotionRepository } from '../../promotions/repositories/promotion.repository.js';
import { toPublicPromotion } from '../../promotions/controllers/restaurant-promotions.controller.js';

/**
 * `/admin/promotions` (docs/04-api-specification.md §8.7, OPERATIONS+).
 * `promotions:platform` — not `promotions:read`/`promotions:write` —
 * gates every route here (only ADMIN_OPERATIONS/SUPER_ADMIN hold it),
 * since an admin can create or edit ANY promotion, restaurant-scoped or
 * platform-wide, unlike `/restaurant/promotions`'s self-service-only
 * `promotions:write`.
 */
@Controller('admin/promotions')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminPromotionsController {
  constructor(@Inject(PromotionRepository) private readonly promotions: PromotionRepository) {}

  @Get()
  @Permissions('promotions:platform')
  @HttpCode(200)
  async list(@Query('cursor') cursor?: string, @Query('limit') limitRaw?: string) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    const page = await this.promotions.listPlatform(cursor, limit);
    return okPage(page.items.map(toPublicPromotion), {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: limit ?? 20,
    });
  }

  @Post()
  @Permissions('promotions:platform')
  @HttpCode(201)
  async create(@CurrentAdmin() admin: { adminUserId: string }, @Body() body: unknown) {
    const input = PromotionCreateDto.parse(body);
    const created = await this.promotions.create({
      ...input,
      restaurantId: input.restaurantId ?? null,
      createdByUserId: admin.adminUserId,
    });
    return ok(toPublicPromotion(created));
  }

  @Patch(':id')
  @Permissions('promotions:platform')
  @HttpCode(200)
  async update(@Param('id') id: string, @Body() body: unknown) {
    const input = PromotionUpdateDto.parse(body);
    const existing = await this.promotions.findById(id);
    if (!existing) {
      throw new NotFoundError('Promotion not found.');
    }
    const updated = await this.promotions.update(id, input);
    return ok(toPublicPromotion(updated));
  }
}
