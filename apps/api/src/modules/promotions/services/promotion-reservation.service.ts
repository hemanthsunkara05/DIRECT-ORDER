import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppError } from '../../../platform/errors/app-error.js';
import { normalizeCode } from '../repositories/promotion.repository.js';
import {
  PromotionEligibilityService,
  couponInvalidError,
} from './promotion-eligibility.service.js';

export interface CheckCouponInput {
  couponCode: string;
  restaurantId: string;
  itemsSubtotalMinor: bigint;
  customerPhone: string;
}

export interface CheckedCoupon {
  promotionId: string;
  couponCode: string;
}

function couponExhaustedError(): AppError {
  return new AppError('COUPON_EXHAUSTED', 409, 'This coupon has reached its usage limit.');
}

/**
 * docs/04-api-specification.md §8.3 steps 6 & 10: the authoritative,
 * LOCKED re-validation, run inside the same transaction that creates
 * the Order (`CheckoutService.createOrderAttempt`) — never before it.
 * Does NOT write the `PromotionRedemption` row itself: it only checks
 * and locks, returning the resolved `promotionId` so the caller can
 * create the Order and its redemption together in ONE nested Prisma
 * write (`tx.order.create({ data: { ..., promotionRedemptions: {
 * create: [...] } } })`) — `customerId` and `orderId` are then both
 * known/auto-linked by construction, with no separate follow-up update
 * needed for either.
 *
 * The discount AMOUNT is deliberately not computed here at all — it
 * was already produced by `calculatePricing()` inside
 * `CheckoutQuoteService`, called as literally the first step of
 * `CheckoutService.checkout()` (so "re-validated at checkout", BR-86,
 * holds by construction: it is a fresh, un-cached call, not a reused
 * page-load quote). Recomputing pricing a SECOND time here, under the
 * lock, solely to defend against a promotion's terms changing in the
 * sub-second gap between that call and this one, was considered and
 * rejected — an explicit, narrow, documented scope boundary (see
 * PHASE_REPORTS.md's Phase 14 entry), not an oversight: the acceptance
 * criteria this phase is held to (docs/14-acceptance-criteria.md) are
 * about usage-limit concurrency, which this DOES fully close via the
 * row lock below, not about a promotion being edited mid-checkout.
 */
@Injectable()
export class PromotionReservationService {
  constructor(
    @Inject(PromotionEligibilityService) private readonly eligibility: PromotionEligibilityService,
  ) {}

  async checkAndLock(
    tx: Prisma.TransactionClient,
    input: CheckCouponInput,
  ): Promise<CheckedCoupon> {
    const code = normalizeCode(input.couponCode);

    // The row lock (docs/02-database-schema.md §6.3: "do not substitute
    // an unlocked count") — resolves code -> id AND locks in one
    // statement via the partial unique index on `code`. Its return
    // value is used only to obtain the id; the fully-typed row is read
    // fresh immediately after, while still holding the lock.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM promotions
      WHERE code = ${code} AND is_active = true AND archived_at IS NULL
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw couponInvalidError();
    }
    const promotion = await tx.promotion.findUniqueOrThrow({ where: { id: locked[0]!.id } });

    this.eligibility.validateCore(promotion, {
      restaurantId: input.restaurantId,
      itemsSubtotalMinor: input.itemsSubtotalMinor,
    });

    if (promotion.firstOrderOnly) {
      // BR-96: "determined from delivered order history" — not from
      // any placed-but-not-yet-delivered order, which a customer could
      // still be mid-lifecycle on.
      const priorDelivered = await tx.order.count({
        where: {
          customerPhone: input.customerPhone,
          status: 'DELIVERED',
          ...(promotion.restaurantId ? { restaurantId: promotion.restaurantId } : {}),
        },
      });
      if (priorDelivered > 0) {
        throw couponInvalidError();
      }
    }

    if (promotion.usageLimitTotal !== null) {
      const totalActive = await tx.promotionRedemption.count({
        where: { promotionId: promotion.id, status: { in: ['RESERVED', 'CONFIRMED'] } },
      });
      if (totalActive >= promotion.usageLimitTotal) {
        throw couponExhaustedError();
      }
    }

    if (promotion.usageLimitPerCustomer !== null) {
      // Keyed by phone, not customerId — see PromotionRedemption's own
      // schema doc comment for why customerId cannot recognise a
      // repeat guest.
      const perCustomerActive = await tx.promotionRedemption.count({
        where: {
          promotionId: promotion.id,
          customerPhone: input.customerPhone,
          status: { in: ['RESERVED', 'CONFIRMED'] },
        },
      });
      if (perCustomerActive >= promotion.usageLimitPerCustomer) {
        throw couponExhaustedError();
      }
    }

    return { promotionId: promotion.id, couponCode: promotion.code };
  }
}
