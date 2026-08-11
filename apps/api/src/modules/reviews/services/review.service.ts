import { Inject, Injectable } from '@nestjs/common';
import type { Review, ReviewResponse } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../../platform/errors/app-error.js';
import { isUniqueConstraintViolation } from '../../../platform/database/prisma-errors.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';
import { OrderRepository } from '../../orders/repositories/order.repository.js';
import { hashToken } from '../../orders/services/cart.service.js';
import { ReviewRepository } from '../repositories/review.repository.js';
import { RatingAggregateService } from './rating-aggregate.service.js';

export interface SubmitReviewInput {
  rating: number;
  body?: string;
}

/**
 * `POST /public/orders/:orderNumber/review` — deliberately NOT
 * `POST /me/reviews` as docs/04-api-specification.md §8.4 names it.
 * That endpoint sits under the authenticated-customer section, but no
 * customer authentication exists anywhere in this codebase (AMB-2:
 * guest checkout is the only path today, same boundary Phase 12 hit
 * for `/me/notifications`). The guest order-access token
 * (`OrderTrackingService`'s exact ownership-check pattern) is the only
 * identity a customer actually has — it IS proof this is their order,
 * which is precisely what BR-117 requires.
 */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
    @Inject(RatingAggregateService) private readonly rating: RatingAggregateService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async submit(orderNumber: string, token: string, input: SubmitReviewInput): Promise<Review> {
    const order = await this.orders.findByOrderNumber(orderNumber);
    if (!order || order.accessTokenHash !== hashToken(token)) {
      throw new NotFoundError('Order not found.');
    }
    // BR-117: only a DELIVERED order for this restaurant, by this
    // customer, may be reviewed — token ownership already proves "this
    // customer's order"; the status check is the remaining half.
    if (order.status !== 'DELIVERED') {
      throw new ConflictError('Only a delivered order can be reviewed.');
    }

    // BR-118 / "one review per order under concurrency": always
    // attempt the insert and let the unique constraint on `order_id`
    // decide — the same insert-and-let-the-constraint-decide pattern
    // every other exactly-once guarantee in this codebase uses (Order
    // idempotency keys, Delivery dispatch), not a check-then-insert
    // race. A friendly pre-check below only improves the common
    // (non-racing) error message; it is not the actual guarantee.
    const existing = await this.reviews.findByOrderId(order.id);
    if (existing) {
      throw new ConflictError('This order has already been reviewed.');
    }

    let review: Review;
    try {
      review = await this.reviews.create({
        orderId: order.id,
        customerId: order.customerId,
        restaurantId: order.restaurantId,
        rating: input.rating,
        body: input.body,
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        const raced = await this.reviews.findByOrderId(order.id);
        if (raced) return raced;
      }
      throw error;
    }

    await this.rating.recompute(order.restaurantId);

    await this.outbox.record(
      'REVIEW_SUBMITTED',
      { reviewId: review.id, restaurantId: order.restaurantId, rating: review.rating },
      order.restaurantId,
    );

    return review;
  }

  /**
   * BR-122: one response per review. BR-121 (restaurants cannot edit,
   * hide, or delete a review) is enforced simply by there being no
   * endpoint that lets a restaurant touch `Review` at all — this method
   * only ever writes to `ReviewResponse`, a separate table.
   */
  async respond(
    reviewId: string,
    restaurantId: string,
    authorUserId: string,
    body: string,
  ): Promise<ReviewResponse> {
    const review = await this.reviews.findByIdForRestaurant(reviewId, restaurantId);
    if (!review) {
      throw new NotFoundError('Review not found.');
    }
    const existing = await this.reviews.findResponseByReviewId(reviewId);
    if (existing) {
      throw new ConflictError('This review already has a response.');
    }
    try {
      return await this.reviews.createResponse(reviewId, restaurantId, authorUserId, body);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        const raced = await this.reviews.findResponseByReviewId(reviewId);
        if (raced) return raced;
      }
      throw error;
    }
  }
}
