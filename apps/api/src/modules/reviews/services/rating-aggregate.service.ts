import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { ReviewRepository } from '../repositories/review.repository.js';

/**
 * Bayesian ("weighted") average — the same shape IMDb's own public
 * rating formula uses: `(C * m + sum(ratings)) / (C + n)`. A brand-new
 * restaurant with one 5-star review should not outrank an established
 * one with a hundred 4.6-average reviews; blending in `C` phantom
 * reviews at the platform-neutral prior `m` pulls a small sample size
 * toward the middle until real volume outweighs it. No product
 * decision fixes these two constants (unlike `PLATFORM_FEE_BPS`, which
 * docs/15-ambiguities-and-risks.md names explicitly) — 3.5 (the
 * numeric midpoint of a 1-5 scale) and 5 (a restaurant needs more than
 * a handful of reviews before its own average dominates) are
 * reasonable, documented defaults, not derived from any spec.
 */
const BAYESIAN_PRIOR_MEAN = 3.5;
const BAYESIAN_PRIOR_WEIGHT = 5;

/**
 * docs/07-events-and-jobs.md names `rating.recompute` as a debounced
 * queue job; this codebase has used a synchronous in-process call
 * instead of a new BullMQ job in every phase so far (the outbox relay,
 * order expiry, notification retry) and does the same here — a full
 * recompute over one restaurant's PUBLISHED reviews is a cheap,
 * single-restaurant-scoped aggregate query, not global work worth
 * queueing. Called directly after every review submission and
 * moderation action, so `Restaurant.ratingAvg`/`ratingCount` are never
 * stale, trivially satisfying BR-123's "reconcilable against source
 * rows" — there is nothing to reconcile, it IS the source computed
 * fresh.
 */
@Injectable()
export class RatingAggregateService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReviewRepository) private readonly reviews: ReviewRepository,
  ) {}

  async recompute(
    restaurantId: string,
  ): Promise<{ ratingAvg: number | null; ratingCount: number }> {
    const { avg, count } = await this.reviews.aggregatePublished(restaurantId);
    // Zero PUBLISHED reviews means "unrated", not "0 stars" — the
    // Bayesian prior only blends into a REAL sample, it never
    // manufactures a rating out of nothing.
    const ratingAvg =
      count === 0
        ? null
        : // Not money — a 1-5 star rating, rounded to 2 decimal places for
          // display. The repo-wide ban on Math.round is specifically about
          // currency (BigInt half-up rounding, packages/money) — a rating
          // average has no minor-unit representation to round instead.
          // eslint-disable-next-line no-restricted-syntax
          Math.round(
            ((BAYESIAN_PRIOR_WEIGHT * BAYESIAN_PRIOR_MEAN + (avg ?? 0) * count) /
              (BAYESIAN_PRIOR_WEIGHT + count)) *
              100,
          ) / 100;

    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { ratingAvg, ratingCount: count },
    });

    return { ratingAvg, ratingCount: count };
  }
}
