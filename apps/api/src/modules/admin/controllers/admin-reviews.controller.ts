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
import type { Review, ReviewStatus } from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { CurrentAdmin } from '../../../platform/authorization/current-admin.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { ReviewRepository } from '../../reviews/repositories/review.repository.js';
import { ModerateReviewDto } from '../../reviews/dto/moderate-review.dto.js';
import { AdminReviewService } from '../services/admin-review.service.js';

const REVIEW_STATUSES: ReviewStatus[] = ['PENDING_REVIEW', 'PUBLISHED', 'HIDDEN', 'REMOVED'];

/** `/admin/reviews*` (docs/04-api-specification.md §8.7, `reviews:moderate`). */
@Controller('admin/reviews')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminReviewsController {
  constructor(
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(AdminReviewService) private readonly moderation: AdminReviewService,
  ) {}

  @Get()
  @Permissions('reviews:moderate')
  @HttpCode(200)
  async list(
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    if (status !== undefined && !REVIEW_STATUSES.includes(status as ReviewStatus)) {
      throw new ValidationError(`status must be one of ${REVIEW_STATUSES.join(', ')}.`);
    }
    const page = await this.reviews.listForAdmin(status as ReviewStatus | undefined, cursor, limit);
    return okPage(page.items.map(toAdminReview), {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: limit ?? 20,
    });
  }

  @Post(':id/moderate')
  @Permissions('reviews:moderate')
  @HttpCode(200)
  async moderate(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = ModerateReviewDto.parse(body);
    const review = await this.moderation.moderate(
      id,
      input.status,
      admin.adminUserId,
      input.reason,
    );
    return ok({ id: review.id, status: review.status });
  }
}

function toAdminReview(review: Review) {
  return {
    id: review.id,
    orderId: review.orderId,
    customerId: review.customerId,
    restaurantId: review.restaurantId,
    rating: review.rating,
    body: review.body,
    status: review.status,
    moderationReason: review.moderationReason,
    createdAt: review.createdAt,
  };
}
