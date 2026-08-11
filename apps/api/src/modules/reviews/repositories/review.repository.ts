import { Inject, Injectable } from '@nestjs/common';
import type { Review, ReviewResponse, ReviewStatus } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateReviewInput {
  orderId: string;
  customerId: string;
  restaurantId: string;
  rating: number;
  body?: string;
}

export interface ReviewPage {
  items: Review[];
  hasMore: boolean;
}

@Injectable()
export class ReviewRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateReviewInput): Promise<Review> {
    return this.prisma.review.create({
      data: {
        orderId: input.orderId,
        customerId: input.customerId,
        restaurantId: input.restaurantId,
        rating: input.rating,
        body: input.body,
      },
    });
  }

  async findByOrderId(orderId: string): Promise<Review | null> {
    return this.prisma.review.findUnique({ where: { orderId } });
  }

  async findById(id: string): Promise<Review | null> {
    return this.prisma.review.findUnique({ where: { id } });
  }

  async findByIdForRestaurant(id: string, restaurantId: string): Promise<Review | null> {
    return this.prisma.review.findFirst({ where: { id, restaurantId } });
  }

  async listPublished(restaurantId: string, cursor?: string, limit = 20): Promise<ReviewPage> {
    const rows = await this.prisma.review.findMany({
      where: { restaurantId, status: 'PUBLISHED' },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  async listForRestaurant(restaurantId: string, cursor?: string, limit = 20): Promise<ReviewPage> {
    const rows = await this.prisma.review.findMany({
      where: { restaurantId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  async listForAdmin(
    status: ReviewStatus | undefined,
    cursor?: string,
    limit = 20,
  ): Promise<ReviewPage> {
    const rows = await this.prisma.review.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  async moderate(
    id: string,
    status: ReviewStatus,
    moderatedByUserId: string,
    reason: string,
  ): Promise<Review> {
    return this.prisma.review.update({
      where: { id },
      data: {
        status,
        moderatedByUserId,
        moderationReason: reason,
        moderatedAt: new Date(),
      },
    });
  }

  /**
   * BR-123: "reconcilable against source rows" — a full aggregate over
   * PUBLISHED rows, computed fresh every time (`RatingAggregateService`
   * calls this synchronously after every mutation), not an
   * incrementally-maintained counter that could drift from source.
   */
  async aggregatePublished(restaurantId: string): Promise<{ avg: number | null; count: number }> {
    const result = await this.prisma.review.aggregate({
      where: { restaurantId, status: 'PUBLISHED' },
      _avg: { rating: true },
      _count: true,
    });
    return { avg: result._avg.rating, count: result._count };
  }

  /** BR-122: `@@unique([reviewId])` is the actual one-response guarantee — a P2002 on retry, not a pre-check race. */
  async createResponse(
    reviewId: string,
    restaurantId: string,
    authorUserId: string,
    body: string,
  ): Promise<ReviewResponse> {
    return this.prisma.reviewResponse.create({
      data: { reviewId, restaurantId, authorUserId, body },
    });
  }

  async findResponseByReviewId(reviewId: string): Promise<ReviewResponse | null> {
    return this.prisma.reviewResponse.findUnique({ where: { reviewId } });
  }
}
