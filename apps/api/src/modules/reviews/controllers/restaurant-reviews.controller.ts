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
import type { Review, User } from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { RespondReviewDto } from '../dto/respond-review.dto.js';
import { ReviewRepository } from '../repositories/review.repository.js';
import { ReviewService } from '../services/review.service.js';

/**
 * `/restaurant/reviews*` (docs/04-api-specification.md §8.5). BR-121:
 * there is no PATCH/DELETE on `Review` anywhere in this controller —
 * "restaurants cannot edit, hide, or delete customer reviews" holds
 * because no such route exists, not because of a runtime check.
 */
@Controller('restaurant/reviews')
@UseGuards(AuthGuard, AuthorizationGuard)
export class RestaurantReviewsController {
  constructor(
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(ReviewService) private readonly reviewService: ReviewService,
  ) {}

  @Get()
  @TenantScoped()
  @Permissions('reviews:read')
  @HttpCode(200)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    const page = await this.reviews.listForRestaurant(tenant.restaurantId, cursor, limit);
    return okPage(page.items.map(toOwnReview), {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: limit ?? 20,
    });
  }

  @Post(':id/response')
  @TenantScoped()
  @Permissions('reviews:respond')
  @HttpCode(201)
  async respond(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = RespondReviewDto.parse(body);
    const response = await this.reviewService.respond(id, tenant.restaurantId, user.id, input.body);
    return ok({ id: response.id, reviewId: response.reviewId, body: response.body });
  }
}

function toOwnReview(review: Review) {
  return {
    id: review.id,
    orderId: review.orderId,
    rating: review.rating,
    body: review.body,
    status: review.status,
    createdAt: review.createdAt,
  };
}
