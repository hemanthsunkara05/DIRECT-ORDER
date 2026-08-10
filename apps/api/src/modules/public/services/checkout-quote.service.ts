import { Inject, Injectable } from '@nestjs/common';
import type { RestaurantSettings } from '@prisma/client';
import { calculatePricing, type PricingBreakdown } from '@direct-order/money';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { NotFoundError } from '../../../platform/errors/app-error.js';
import {
  AvailabilityService,
  type AvailabilityReason,
} from '../../availability/availability.service.js';
import { PublicRestaurantRepository } from '../repositories/public-restaurant.repository.js';
import { PublicMenuRepository } from '../repositories/public-menu.repository.js';
import type { QuoteCartInput } from '../dto/quote-cart.dto.js';

export type CartIssue =
  | { code: 'RESTAURANT_UNAVAILABLE'; reason: AvailabilityReason }
  | { code: 'ITEM_UNAVAILABLE'; itemId: string }
  | { code: 'PRICE_CHANGED'; itemId: string; oldPriceMinor: string; newPriceMinor: string }
  | { code: 'BELOW_MINIMUM_ORDER'; minimumMinor: string; subtotalMinor: string };

export interface QuoteResult {
  valid: boolean;
  issues: CartIssue[];
  breakdown: PricingBreakdown;
}

/**
 * `POST /public/checkout/quote` — "authoritative pricing"
 * (docs/04-api-specification.md §8.3). Runs the pricing-relevant
 * subset of the mandated checkout sequence (§8.3's numbered steps
 * 2–5, 8): availability, live item state, price-drift detection,
 * minimum order, then the pricing engine — without steps 1 (cart
 * lookup, no persisted cart exists yet), 6–7 (coupon/loyalty
 * reservation, no Promotion/Loyalty tables yet), or 9–12 (order
 * creation, Phase 9). Phase 9's real checkout endpoint will call this
 * same validation shape before creating an order, so "quote total
 * exactly matches what checkout will charge" holds by construction —
 * one function, not two independently-maintained copies.
 *
 * Issues are returned in the response body (200), not as a single
 * fatal error — `docs/13-implementation-phases.md`'s "server-side cart
 * validation with per-item issue codes" implies the customer sees
 * what's wrong (this item's price changed, that item is unavailable)
 * rather than getting a generic failure. `valid: false` is what
 * actually blocks proceeding; the breakdown is still computed from
 * whatever items passed validation, so the frontend can show "here's
 * your total once you fix the flagged items."
 */
@Injectable()
export class CheckoutQuoteService {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(PublicRestaurantRepository) private readonly restaurants: PublicRestaurantRepository,
    @Inject(PublicMenuRepository) private readonly menu: PublicMenuRepository,
    @Inject(AvailabilityService) private readonly availability: AvailabilityService,
  ) {}

  async quote(input: QuoteCartInput): Promise<QuoteResult> {
    const restaurant = await this.restaurants.findBySlug(input.restaurantSlug);
    if (!restaurant || restaurant.status === 'DRAFT' || restaurant.status === 'PENDING_APPROVAL') {
      throw new NotFoundError('Restaurant not found.');
    }

    const issues: CartIssue[] = [];

    const decision = await this.availability.isAcceptingOrders(restaurant.id);
    if (!decision.accepting) {
      issues.push({ code: 'RESTAURANT_UNAVAILABLE', reason: decision.reason });
    }

    const liveItems = await this.menu.findByIds(
      restaurant.id,
      input.items.map((line) => line.itemId),
    );
    const liveById = new Map(liveItems.map((item) => [item.id, item]));

    const validLines: { itemId: string; name: string; unitPriceMinor: bigint; quantity: number }[] =
      [];

    for (const cartLine of input.items) {
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

    const breakdown = calculatePricing({
      items: validLines,
      packagingFeeMinor: hasValidItems ? (settings?.packagingFeeMinor ?? 0n) : 0n,
      deliveryFeeMinor: hasValidItems ? resolveDeliveryFeeMinor(settings) : 0n,
      platformFeeBps: hasValidItems ? this.env.PLATFORM_FEE_BPS : 0,
    });

    const minOrderAmountMinor = settings?.minOrderAmountMinor ?? 0n;
    if (hasValidItems && breakdown.itemsSubtotalMinor < minOrderAmountMinor) {
      issues.push({
        code: 'BELOW_MINIMUM_ORDER',
        minimumMinor: minOrderAmountMinor.toString(),
        subtotalMinor: breakdown.itemsSubtotalMinor.toString(),
      });
    }

    return { valid: issues.length === 0, issues, breakdown };
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
