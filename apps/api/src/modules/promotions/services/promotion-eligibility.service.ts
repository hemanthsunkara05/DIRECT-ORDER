import { Injectable } from '@nestjs/common';
import type { Promotion } from '@prisma/client';
import type { PromotionDiscountInput } from '@direct-order/money';
import { AppError } from '../../../platform/errors/app-error.js';

/**
 * BR-95 (anti-enumeration): every rejection reason below — code doesn't
 * exist, inactive, archived, outside its active window, wrong
 * restaurant, order doesn't meet the coupon's own minimum — throws the
 * exact same generic error. An attacker probing codes learns nothing
 * beyond "that one didn't work"; `COUPON_EXHAUSTED` (thrown separately,
 * by `PromotionReservationService`, only once a code is already known
 * to be genuinely valid) is the one case allowed to be more specific,
 * since it doesn't leak anything about codes the caller doesn't
 * already know are real.
 */
export function couponInvalidError(): AppError {
  return new AppError('COUPON_INVALID', 409, 'This coupon code is not valid for this order.');
}

/**
 * The subset of validation that doesn't depend on customer identity —
 * shared by the quote-time preview (no customer known yet, BR-86:
 * "validated in the cart") and the checkout-time authoritative
 * re-validation (BR-86: "re-validated at checkout"), which additionally
 * checks first-order-eligibility and usage limits under a real lock
 * (`PromotionReservationService`) — this function alone is never
 * sufficient to actually reserve a redemption.
 */
@Injectable()
export class PromotionEligibilityService {
  validateCore(
    promotion: Promotion,
    context: { restaurantId: string; itemsSubtotalMinor: bigint },
    now: Date = new Date(),
  ): void {
    if (!promotion.isActive || promotion.archivedAt) {
      throw couponInvalidError();
    }
    if (promotion.startsAt && promotion.startsAt.getTime() > now.getTime()) {
      throw couponInvalidError();
    }
    if (promotion.endsAt && promotion.endsAt.getTime() < now.getTime()) {
      throw couponInvalidError();
    }
    if (promotion.restaurantId && promotion.restaurantId !== context.restaurantId) {
      throw couponInvalidError();
    }
    if (promotion.minOrderMinor !== null && context.itemsSubtotalMinor < promotion.minOrderMinor) {
      throw couponInvalidError();
    }
  }

  /**
   * Resolves an already-validated `Promotion` into the pricing engine's
   * input shape (`@direct-order/money`'s `calculatePricing`) — the
   * pricing engine has priced PERCENTAGE/FIXED_AMOUNT promotions since
   * Phase 8; this phase only ever resolves a real coupon code into that
   * same shape, never adds a second discount computation. FREE_DELIVERY
   * is expressed as a FIXED_AMOUNT capped at THIS order's real delivery
   * fee — `Promotion.value` for a FREE_DELIVERY row is advisory only
   * (see its schema comment) and is never read here, so a coupon
   * mis-configured with a large FREE_DELIVERY value can never discount
   * more than the delivery fee actually charged.
   */
  toPricingDiscountInput(promotion: Promotion, deliveryFeeMinor: bigint): PromotionDiscountInput {
    if (promotion.type === 'PERCENTAGE') {
      return {
        type: 'PERCENTAGE',
        percent: promotion.value,
        capMinor: promotion.maxDiscountMinor ?? undefined,
      };
    }
    if (promotion.type === 'FREE_DELIVERY') {
      return { type: 'FIXED_AMOUNT', valueMinor: deliveryFeeMinor };
    }
    return { type: 'FIXED_AMOUNT', valueMinor: BigInt(promotion.value) };
  }
}
