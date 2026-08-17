import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
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
import { AdminQueryRepository } from '../repositories/admin-query.repository.js';
import { RestaurantStateService } from '../services/restaurant-state.service.js';
import { ReasonDto } from '../dto/reason.dto.js';

/** `/admin/restaurants*` (docs/04-api-specification.md §8.7, Phase 13). */
@Controller('admin/restaurants')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminRestaurantsController {
  constructor(
    @Inject(AdminQueryRepository) private readonly admin: AdminQueryRepository,
    @Inject(RestaurantStateService) private readonly restaurantState: RestaurantStateService,
  ) {}

  @Get()
  @Permissions('restaurant:read')
  @HttpCode(200)
  async list(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
    @Query('order') orderRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    // Phase 21a: the Approval Queue passes order=oldest for FIFO review;
    // every other/existing caller omits it and keeps today's newest-first
    // behavior unchanged.
    if (orderRaw !== undefined && orderRaw !== 'newest' && orderRaw !== 'oldest') {
      throw new ValidationError("order must be 'newest' or 'oldest'.");
    }
    const order = orderRaw === 'oldest' ? 'oldest' : 'newest';
    const page = await this.admin.listRestaurants({ status, search }, { cursor, limit }, order);
    return okPage(page.items, {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: limit ?? 20,
    });
  }

  @Get('unclaimed')
  @Permissions('restaurant:read')
  @HttpCode(200)
  async unclaimed() {
    const rows = await this.admin.listUnclaimed();
    return ok(rows);
  }

  /**
   * Phase 21a: the Approval Queue's per-row decision detail — address,
   * menu summary, branding. `:id/detail` (not folded into `GET :id`,
   * since no plain `GET :id` route exists on this controller today) to
   * keep the flat list endpoint above cheap for every other caller.
   */
  @Get(':id/detail')
  @Permissions('restaurant:read')
  @HttpCode(200)
  async detail(@Param('id') id: string) {
    const result = await this.admin.getRestaurantDetail(id);
    if (!result) {
      throw new NotFoundError('Restaurant not found.');
    }
    return ok({
      id: result.restaurant.id,
      slug: result.restaurant.slug,
      name: result.restaurant.name,
      description: result.restaurant.description,
      status: result.restaurant.status,
      submittedAt: result.restaurant.submittedAt,
      address: result.address,
      branding: result.branding,
      menuSummary: result.menuSummary,
    });
  }

  @Post(':id/approve')
  @Permissions('restaurant:approve')
  @HttpCode(200)
  async approve(@CurrentAdmin() admin: { adminUserId: string }, @Param('id') id: string) {
    const restaurant = await this.restaurantState.approve(id, admin.adminUserId);
    return ok({ id: restaurant.id, status: restaurant.status });
  }

  /** Phase 21a — mirrors `suspend()`'s exact shape (reason required, same permission-check pattern). */
  @Post(':id/reject')
  @Permissions('restaurant:reject')
  @HttpCode(200)
  async reject(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = ReasonDto.parse(body);
    const restaurant = await this.restaurantState.reject(id, admin.adminUserId, input.reason);
    return ok({ id: restaurant.id, status: restaurant.status });
  }

  @Post(':id/suspend')
  @Permissions('restaurant:suspend')
  @HttpCode(200)
  async suspend(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = ReasonDto.parse(body);
    const restaurant = await this.restaurantState.suspend(id, admin.adminUserId, input.reason);
    return ok({ id: restaurant.id, status: restaurant.status });
  }

  @Post(':id/reinstate')
  @Permissions('restaurant:suspend')
  @HttpCode(200)
  async reinstate(@CurrentAdmin() admin: { adminUserId: string }, @Param('id') id: string) {
    const restaurant = await this.restaurantState.reinstate(id, admin.adminUserId);
    return ok({ id: restaurant.id, status: restaurant.status });
  }
}
