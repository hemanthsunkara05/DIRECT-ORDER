/**
 * The pricing engine (Phase 8, PRODUCT/docs/13-implementation-phases.md).
 * Lives in `@direct-order/money` deliberately — it IS money arithmetic
 * (BR-1: "Floating-point arithmetic on money is forbidden anywhere in
 * the stack"), and this package is already the one place that's exempt
 * from the repo-wide ESLint ban on float-producing operations. Every
 * later phase that needs a price (cart validation, checkout, promotion
 * redemption, loyalty redemption, refund calculation) calls this SAME
 * function rather than re-deriving totals — the "one pricing engine"
 * architectural resolution: all consumers agree by construction, not by
 * convention.
 */

import { percentageOf, sum, type Minor } from './index.js';

export interface PricingLineItemInput {
  itemId: string;
  name: string;
  unitPriceMinor: Minor;
  /** A positive integer — quantity caps (BR-23, e.g. 99) are a request-shape concern enforced at the DTO layer, not here. */
  quantity: number;
}

export interface PricingLineResult {
  itemId: string;
  name: string;
  unitPriceMinor: Minor;
  quantity: number;
  /** BR-4: unit price snapshot × quantity, exactly. */
  lineTotalMinor: Minor;
}

export type PromotionDiscountInput =
  | { type: 'PERCENTAGE'; percent: number; capMinor?: Minor }
  | { type: 'FIXED_AMOUNT'; valueMinor: Minor };

export interface PricingInput {
  items: PricingLineItemInput[];
  packagingFeeMinor?: Minor;
  deliveryFeeMinor?: Minor;
  /**
   * Basis points (1/100 of a percent) of the items subtotal — e.g. 250
   * = 2.5%. Configured platform-wide via `PLATFORM_FEE_BPS`, not per
   * restaurant (no RestaurantSettings field exists for this; BR-14:
   * "may be zero during the pilot" — zero is the default, rendering as
   * an absent line rather than a "₹0 platform fee" one).
   */
  platformFeeBps?: number;
  /**
   * GST rate as a percent (e.g. 5 for 5%), applied once to the items
   * subtotal, exclusive (added on top). Tax treatment (inclusive vs
   * exclusive, per-item vs order-level) is an explicit product decision
   * requiring real tax advice (BR-15, docs/15-ambiguities-and-risks.md)
   * — this is the simplest defensible default, not a final answer.
   * Omitted or 0 means no tax line, not a "₹0 tax" line (BR-14's
   * zero-renders-as-absent pattern applied consistently).
   */
  taxPercent?: number;
  /** Already resolved to a specific promotion instance's terms — this engine prices a discount, it does not look up a coupon code. */
  promotion?: PromotionDiscountInput;
  /** Already resolved to a minor-unit amount (points→rupees conversion is the loyalty domain's job, not pricing's). */
  loyaltyDiscountMinor?: Minor;
}

export interface PricingBreakdown {
  items: PricingLineResult[];
  itemsSubtotalMinor: Minor;
  packagingFeeMinor: Minor;
  deliveryFeeMinor: Minor;
  platformFeeMinor: Minor;
  taxMinor: Minor;
  /** The base discounts are computed against — the items subtotal, before fees/tax (BR-22's same reference point for minimum-order checks). */
  discountableBaseMinor: Minor;
  promotionDiscountMinor: Minor;
  loyaltyDiscountMinor: Minor;
  /** promotionDiscountMinor + loyaltyDiscountMinor, already capped — BR-7. */
  discountMinor: Minor;
  /** BR-3, BR-6: subtotal + fees + tax − discount, clamped so it can never go negative. */
  payableTotalMinor: Minor;
}

/**
 * The single source of truth for what an order costs (BR-3: "Order
 * total = items subtotal + packaging fee + delivery fee + platform fee
 * + tax − discounts − loyalty discount"). Pure and deterministic — no
 * I/O, no Date.now()/Math.random(), same input always yields identical
 * output, so a quote and the checkout that follows it can call this
 * with the same inputs and get the same answer by construction.
 */
export function calculatePricing(input: PricingInput): PricingBreakdown {
  const items: PricingLineResult[] = input.items.map((item) => {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new TypeError(
        `calculatePricing() received a non-positive-integer quantity for item ${item.itemId}: ${item.quantity}`,
      );
    }
    return {
      itemId: item.itemId,
      name: item.name,
      unitPriceMinor: item.unitPriceMinor,
      quantity: item.quantity,
      lineTotalMinor: item.unitPriceMinor * BigInt(item.quantity),
    };
  });

  const itemsSubtotalMinor = sum(...items.map((line) => line.lineTotalMinor));
  const packagingFeeMinor = input.packagingFeeMinor ?? 0n;
  const deliveryFeeMinor = input.deliveryFeeMinor ?? 0n;
  const platformFeeBps = input.platformFeeBps ?? 0;
  // BR-5: rounded once, here, never re-rounded on any later sum. bps -> percent: 100 bps = 1%.
  const platformFeeMinor =
    platformFeeBps > 0 ? percentageOf(itemsSubtotalMinor, platformFeeBps / 100) : 0n;
  const taxPercent = input.taxPercent ?? 0;
  const taxMinor = taxPercent > 0 ? percentageOf(itemsSubtotalMinor, taxPercent) : 0n;

  const discountableBaseMinor = itemsSubtotalMinor;

  // BR-7: combined discounts may not exceed the discountable base.
  // Promotion is clamped against the full base first, then loyalty
  // against whatever base remains — a deterministic priority order
  // (promotion first), not an arbitrary simultaneous split.
  const rawPromotionDiscountMinor = computePromotionDiscount(
    input.promotion,
    discountableBaseMinor,
  );
  const promotionDiscountMinor = clampMinor(rawPromotionDiscountMinor, 0n, discountableBaseMinor);
  const remainingBaseMinor = discountableBaseMinor - promotionDiscountMinor;
  const rawLoyaltyDiscountMinor = input.loyaltyDiscountMinor ?? 0n;
  const loyaltyDiscountMinor = clampMinor(rawLoyaltyDiscountMinor, 0n, remainingBaseMinor);
  const discountMinor = promotionDiscountMinor + loyaltyDiscountMinor;

  const beforeDiscountMinor = sum(
    itemsSubtotalMinor,
    packagingFeeMinor,
    deliveryFeeMinor,
    platformFeeMinor,
    taxMinor,
  );
  // BR-6: payable_total_minor >= 0 always, enforced here as the final
  // clamp — mathematically redundant given discountMinor is already
  // capped at discountableBaseMinor <= beforeDiscountMinor, but kept as
  // an explicit, literal invariant rather than an implied one.
  const payableTotalMinor = clampMinor(
    beforeDiscountMinor - discountMinor,
    0n,
    beforeDiscountMinor,
  );

  return {
    items,
    itemsSubtotalMinor,
    packagingFeeMinor,
    deliveryFeeMinor,
    platformFeeMinor,
    taxMinor,
    discountableBaseMinor,
    promotionDiscountMinor,
    loyaltyDiscountMinor,
    discountMinor,
    payableTotalMinor,
  };
}

function computePromotionDiscount(
  promotion: PromotionDiscountInput | undefined,
  baseMinor: Minor,
): Minor {
  if (!promotion) return 0n;
  if (promotion.type === 'FIXED_AMOUNT') return promotion.valueMinor;
  const raw = percentageOf(baseMinor, promotion.percent);
  return promotion.capMinor !== undefined && raw > promotion.capMinor ? promotion.capMinor : raw;
}

function clampMinor(value: Minor, min: Minor, max: Minor): Minor {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
