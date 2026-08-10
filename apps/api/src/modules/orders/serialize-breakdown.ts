import type { PricingBreakdown } from '@direct-order/money';

/**
 * `PricingBreakdown`'s fields are BigInt — neither `JSON.stringify` nor
 * Prisma's `Json` column type can hold one directly. This is the one
 * place that breakdown gets flattened to an all-string, wire/storage
 * -safe shape, reused by the checkout response, `Order.pricingBreakdown`
 * (so a stored order's breakdown round-trips through the same shape a
 * fresh quote would produce), and the order-tracking response —
 * replacing `public-checkout.controller.ts`'s local `toPublicQuote`
 * mapping, which duplicated this exact transformation.
 */
export interface SerializedPricingBreakdown {
  items: {
    itemId: string;
    name: string;
    unitPriceMinor: string;
    quantity: number;
    lineTotalMinor: string;
  }[];
  itemsSubtotalMinor: string;
  packagingFeeMinor: string;
  deliveryFeeMinor: string;
  platformFeeMinor: string;
  taxMinor: string;
  discountableBaseMinor: string;
  promotionDiscountMinor: string;
  loyaltyDiscountMinor: string;
  discountMinor: string;
  payableTotalMinor: string;
}

export function serializeBreakdown(breakdown: PricingBreakdown): SerializedPricingBreakdown {
  return {
    items: breakdown.items.map((item) => ({
      itemId: item.itemId,
      name: item.name,
      unitPriceMinor: item.unitPriceMinor.toString(),
      quantity: item.quantity,
      lineTotalMinor: item.lineTotalMinor.toString(),
    })),
    itemsSubtotalMinor: breakdown.itemsSubtotalMinor.toString(),
    packagingFeeMinor: breakdown.packagingFeeMinor.toString(),
    deliveryFeeMinor: breakdown.deliveryFeeMinor.toString(),
    platformFeeMinor: breakdown.platformFeeMinor.toString(),
    taxMinor: breakdown.taxMinor.toString(),
    discountableBaseMinor: breakdown.discountableBaseMinor.toString(),
    promotionDiscountMinor: breakdown.promotionDiscountMinor.toString(),
    loyaltyDiscountMinor: breakdown.loyaltyDiscountMinor.toString(),
    discountMinor: breakdown.discountMinor.toString(),
    payableTotalMinor: breakdown.payableTotalMinor.toString(),
  };
}
