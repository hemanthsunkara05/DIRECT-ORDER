import { Inject, Injectable } from '@nestjs/common';
import type { Promotion, RestaurantSettings } from '@prisma/client';
import { calculatePricing, type PricingBreakdown } from '@direct-order/money';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { NotFoundError, AppError } from '../../../platform/errors/app-error.js';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import {
  AvailabilityService,
  type AvailabilityReason,
} from '../../availability/availability.service.js';
import {
  couponInvalidError,
  PromotionEligibilityService,
} from '../../promotions/services/promotion-eligibility.service.js';
import { PromotionRepository } from '../../promotions/repositories/promotion.repository.js';
import {
  PublicRestaurantRepository,
  type RestaurantWithPublicRelations,
} from '../repositories/public-restaurant.repository.js';
import { PublicMenuRepository } from '../repositories/public-menu.repository.js';
import type { QuoteCartInput } from '../dto/quote-cart.dto.js';

export type CartIssue =
  | { code: 'RESTAURANT_UNAVAILABLE'; reason: AvailabilityReason }
  | { code: 'ITEM_UNAVAILABLE'; itemId: string }
  | { code: 'PRICE_CHANGED'; itemId: string; oldPriceMinor: string; newPriceMinor: string }
  | { code: 'BELOW_MINIMUM_ORDER'; minimumMinor: string; subtotalMinor: string }
  /** BR-95 anti-enumeration: a nonexistent code, an inactive/expired/archived one, a wrong-restaurant one, and one that fails its own min-order all collapse into this same issue — never distinguished. */
  | { code: 'COUPON_INVALID' }
  | { code: 'COUPON_EXHAUSTED' };

export interface QuoteResult {
  valid: boolean;
  issues: CartIssue[];
  breakdown: PricingBreakdown;
}

/**
 * `POST /public/checkout/quote` — "authoritative pricing"
 * (docs/04-api-specification.md §8.3). Runs the pricing-relevant
 * subset of the mandated checkout sequence (§8.3's numbered steps
 * 2–6, 8): availability, live item state, price-drift detection,
 * minimum order, a coupon preview (Phase 14 — see this class's own
 * "couponCode resolution" paragraph below), then the pricing engine —
 * without step 1 (cart lookup, no persisted cart exists yet), step 7
 * (loyalty reservation — see the `loyaltyDiscountMinor` param doc on
 * `quoteByRestaurantId` below for why this endpoint's OWN request
 * shape still has no loyalty field even though Phase 16 exists), or
 * 9–12 (order creation, Phase 9). Phase 9's real checkout endpoint
 * calls this same validation shape before creating an order, so "quote
 * total exactly matches what checkout will charge" holds by
 * construction — one function, not two independently-maintained
 * copies.
 *
 * Issues are returned in the response body (200), not as a single
 * fatal error — `docs/13-implementation-phases.md`'s "server-side cart
 * validation with per-item issue codes" implies the customer sees
 * what's wrong (this item's price changed, that item is unavailable)
 * rather than getting a generic failure. `valid: false` is what
 * actually blocks proceeding; the breakdown is still computed from
 * whatever items passed validation, so the frontend can show "here's
 * your total once you fix the flagged items."
 *
 * `couponCode` resolution here (Phase 14) is the "validated in the
 * cart" half of BR-86 — a lightweight, NON-locking preview: it checks
 * everything `PromotionEligibilityService.validateCore` covers plus a
 * best-effort (not authoritative) usage-headroom read, but never
 * reserves anything and never checks per-customer/first-order limits
 * (no customer identity exists yet at this endpoint — `QuoteCartDto`
 * has no customer field). The authoritative "re-validated at checkout"
 * half, including the real row lock and identity-based checks, is
 * `PromotionReservationService`, called from `CheckoutService` inside
 * the order-creation transaction.
 */
@Injectable()
export class CheckoutQuoteService {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PublicRestaurantRepository) private readonly restaurants: PublicRestaurantRepository,
    @Inject(PublicMenuRepository) private readonly menu: PublicMenuRepository,
    @Inject(AvailabilityService) private readonly availability: AvailabilityService,
    @Inject(PromotionRepository) private readonly promotions: PromotionRepository,
    @Inject(PromotionEligibilityService) private readonly eligibility: PromotionEligibilityService,
  ) {}

  async quote(input: QuoteCartInput): Promise<QuoteResult> {
    const restaurant = await this.restaurants.findBySlug(input.restaurantSlug);
    if (!restaurant || restaurant.status === 'DRAFT' || restaurant.status === 'PENDING_APPROVAL') {
      throw new NotFoundError('Restaurant not found.');
    }
    return this.runQuote(restaurant, input.items, input.couponCode);
  }

  /**
   * CartService.validate() and CheckoutService's entry point — both
   * already have a `restaurantId` (from a persisted Cart row) rather
   * than a slug. Same validation, same pricing call, same result shape
   * as `quote()` — "one function", not two independently-maintained
   * copies, extended to a second caller shape instead of duplicated
   * for it.
   *
   * `loyaltyDiscountMinor` (Phase 16) is deliberately NOT part of
   * `QuoteCartDto` / the public, unauthenticated `quote()` entry point
   * above — resolving it needs a customer identity that endpoint never
   * has (guests price-check too). Only `CheckoutService` ever passes
   * it, already resolved from an authenticated customer's requested
   * `redeemLoyaltyPoints` before calling this method.
   */
  async quoteByRestaurantId(
    restaurantId: string,
    items: QuoteCartInput['items'],
    couponCode?: string,
    loyaltyDiscountMinor?: bigint,
  ): Promise<QuoteResult> {
    const restaurant = await this.restaurants.findById(restaurantId);
    if (!restaurant || restaurant.status === 'DRAFT' || restaurant.status === 'PENDING_APPROVAL') {
      throw new NotFoundError('Restaurant not found.');
    }
    return this.runQuote(restaurant, items, couponCode, loyaltyDiscountMinor);
  }

  private async runQuote(
    restaurant: RestaurantWithPublicRelations,
    items: QuoteCartInput['items'],
    couponCode?: string,
    loyaltyDiscountMinor?: bigint,
  ): Promise<QuoteResult> {
    const issues: CartIssue[] = [];

    const decision = await this.availability.isAcceptingOrders(restaurant.id);
    if (!decision.accepting) {
      issues.push({ code: 'RESTAURANT_UNAVAILABLE', reason: decision.reason });
    }

    const liveItems = await this.menu.findByIds(
      restaurant.id,
      items.map((line) => line.itemId),
    );
    const liveById = new Map(liveItems.map((item) => [item.id, item]));

    const validLines: { itemId: string; name: string; unitPriceMinor: bigint; quantity: number }[] =
      [];

    for (const cartLine of items) {
      const live = liveById.get(cartLine.itemId);
      // Missing entirely, archived, taken off the menu, or 86'd — all
      // the same customer-facing "you can't have this" outcome
      // (docs/04-api-specification.md §8.3 step 3: "Missing/archived/
      // unavailable").
      if (!live || live.archivedAt || !live.isActive || !live.isAvailable) {
        issues.push({ code: 'ITEM_UNAVAILABLE', itemId: cartLine.itemId });
        continue;
      }
      if (live.priceMinor !== cartLine.unitPriceMinorAtAdd) {
        issues.push({
          code: 'PRICE_CHANGED',
          itemId: cartLine.itemId,
          oldPriceMinor: cartLine.unitPriceMinorAtAdd.toString(),
          newPriceMinor: live.priceMinor.toString(),
        });
        continue;
      }
      validLines.push({
        itemId: live.id,
        name: live.name,
        unitPriceMinor: live.priceMinor,
        quantity: cartLine.quantity,
      });
    }

    const hasValidItems = validLines.length > 0;
    const settings = restaurant.settings;
    const packagingFeeMinor = hasValidItems ? (settings?.packagingFeeMinor ?? 0n) : 0n;
    const deliveryFeeMinor = hasValidItems ? resolveDeliveryFeeMinor(settings) : 0n;
    const platformFeeBps = hasValidItems ? this.env.PLATFORM_FEE_BPS : 0;

    const baseBreakdown = calculatePricing({
      items: validLines,
      packagingFeeMinor,
      deliveryFeeMinor,
      platformFeeBps,
    });

    const minOrderAmountMinor = settings?.minOrderAmountMinor ?? 0n;
    if (hasValidItems && baseBreakdown.itemsSubtotalMinor < minOrderAmountMinor) {
      issues.push({
        code: 'BELOW_MINIMUM_ORDER',
        minimumMinor: minOrderAmountMinor.toString(),
        subtotalMinor: baseBreakdown.itemsSubtotalMinor.toString(),
      });
    }

    let promotion: Promotion | null = null;
    if (couponCode && hasValidItems) {
      try {
        promotion = await this.resolveCoupon(
          couponCode,
          restaurant.id,
          baseBreakdown.itemsSubtotalMinor,
        );
      } catch (err) {
        issues.push(
          err instanceof AppError && err.code === 'COUPON_EXHAUSTED'
            ? { code: 'COUPON_EXHAUSTED' }
            : { code: 'COUPON_INVALID' },
        );
      }
    }

    const breakdown =
      promotion || loyaltyDiscountMinor
        ? calculatePricing({
            items: validLines,
            packagingFeeMinor,
            deliveryFeeMinor,
            platformFeeBps,
            ...(promotion
              ? { promotion: this.eligibility.toPricingDiscountInput(promotion, deliveryFeeMinor) }
              : {}),
            ...(loyaltyDiscountMinor ? { loyaltyDiscountMinor } : {}),
          })
        : baseBreakdown;

    return { valid: issues.length === 0, issues, breakdown };
  }

  /**
   * Non-locking preview only — see this class's own doc comment.
   * `usageLimitTotal` gets a best-effort read here purely for early UX
   * feedback ("this coupon looks exhausted"); it is NOT the
   * authoritative check, which happens under a real lock in
   * `PromotionReservationService` at actual checkout.
   */
  private async resolveCoupon(
    couponCode: string,
    restaurantId: string,
    itemsSubtotalMinor: bigint,
  ): Promise<Promotion> {
    const promotion = await this.promotions.findByActiveCode(couponCode);
    if (!promotion) {
      throw couponInvalidError();
    }
    this.eligibility.validateCore(promotion, { restaurantId, itemsSubtotalMinor });

    if (promotion.usageLimitTotal !== null) {
      const activeCount = await this.prisma.promotionRedemption.count({
        where: { promotionId: promotion.id, status: { in: ['RESERVED', 'CONFIRMED'] } },
      });
      if (activeCount >= promotion.usageLimitTotal) {
        throw new AppError('COUPON_EXHAUSTED', 409, 'This coupon has reached its usage limit.');
      }
    }

    return promotion;
  }
}

/**
 * FLAT and FREE are fully supported. DISTANCE_BASED falls back to the
 * flat fee value — real distance-based pricing needs geocoding/
 * distance tooling that doesn't exist until delivery integration
 * (Phase 11+); this is a documented placeholder, not a real
 * distance calculation.
 */
function resolveDeliveryFeeMinor(settings: RestaurantSettings | null): bigint {
  if (!settings) return 0n;
  if (settings.deliveryFeeMode === 'FREE') return 0n;
  return settings.deliveryFeeFlatMinor;
}
