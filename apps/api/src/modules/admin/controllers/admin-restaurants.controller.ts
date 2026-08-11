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
import { ValidationError } from '../../../platform/errors/app-error.js';
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
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    const page = await this.admin.listRestaurants({ status, search }, { cursor, limit });
    return okPage(page.items, {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: limit ?? 20,
    });
  }

  @Post(':id/approve')
  @Permissions('restaurant:approve')
  @HttpCode(200)
  async approve(@CurrentAdmin() admin: { adminUserId: string }, @Param('id') id: string) {
    const restaurant = await this.restaurantState.approve(id, admin.adminUserId);
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
