import { Inject, Injectable } from '@nestjs/common';
import type { Review, ReviewStatus } from '@prisma/client';
import { NotFoundError } from '../../../platform/errors/app-error.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';
import { ReviewRepository } from '../../reviews/repositories/review.repository.js';
import { RatingAggregateService } from '../../reviews/services/rating-aggregate.service.js';

/**
 * `POST /admin/reviews/:id/moderate` (docs/04-api-specification.md
 * §8.7, `reviews:moderate`). AMB-16: reviews publish immediately;
 * this is the reactive half — an admin can move a review to
 * HIDDEN/REMOVED (or back to PUBLISHED) with a reason, always audited.
 * The rating aggregate is recomputed after every moderation action
 * (not just submission) since PUBLISHED-status membership is exactly
 * what `RatingAggregateService.recompute` sums over — moderating a
 * review in or out of PUBLISHED must be reflected immediately (BR-123).
 */
@Injectable()
export class AdminReviewService {
  constructor(
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(RatingAggregateService) private readonly rating: RatingAggregateService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async moderate(
    reviewId: string,
    status: ReviewStatus,
    adminUserId: string,
    reason: string,
  ): Promise<Review> {
    const existing = await this.reviews.findById(reviewId);
    if (!existing) {
      throw new NotFoundError('Review not found.');
    }

    const updated = await this.reviews.moderate(reviewId, status, adminUserId, reason);
    await this.rating.recompute(updated.restaurantId);

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: 'REVIEW_MODERATED',
      entityType: 'Review',
      entityId: reviewId,
      restaurantId: updated.restaurantId,
      before: { status: existing.status },
      after: { status: updated.status },
      reason,
    });

    await this.outbox.record(
      'REVIEW_MODERATED',
      { reviewId: updated.id, status: updated.status },
      updated.restaurantId,
    );

    return updated;
  }
}
