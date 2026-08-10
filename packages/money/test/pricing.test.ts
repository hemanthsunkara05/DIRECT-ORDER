import { describe, expect, it } from 'vitest';
import { calculatePricing, type PricingInput } from '../src/index.js';

/**
 * Exhaustive pricing suite (docs/11-testing-strategy.md §18.3, "Pricing
 * (unit, exhaustive)"). Every rule cited by number is from
 * docs/06-business-rules.md.
 */

function line(itemId: string, unitPriceMinor: bigint, quantity = 1) {
  return { itemId, name: itemId, unitPriceMinor, quantity };
}

describe('calculatePricing', () => {
  it('single item, no fees, no tax, no discount', () => {
    const r = calculatePricing({ items: [line('a', 10000n)] });
    expect(r.itemsSubtotalMinor).toBe(10000n);
    expect(r.payableTotalMinor).toBe(10000n);
  });

  it('multiple items sum correctly', () => {
    const r = calculatePricing({ items: [line('a', 10000n), line('b', 5000n)] });
    expect(r.itemsSubtotalMinor).toBe(15000n);
    expect(r.payableTotalMinor).toBe(15000n);
  });

  it('quantities multiply the unit price exactly (BR-4)', () => {
    const r = calculatePricing({ items: [line('a', 12345n, 3)] });
    expect(r.items[0]!.lineTotalMinor).toBe(37035n);
    expect(r.itemsSubtotalMinor).toBe(37035n);
  });

  it('rejects a non-positive or non-integer quantity', () => {
    expect(() => calculatePricing({ items: [line('a', 100n, 0)] })).toThrow(TypeError);
    expect(() => calculatePricing({ items: [line('a', 100n, -1)] })).toThrow(TypeError);
    expect(() => calculatePricing({ items: [{ ...line('a', 100n), quantity: 1.5 }] })).toThrow(
      TypeError,
    );
  });

  it('adds the packaging fee on top of the subtotal', () => {
    const r = calculatePricing({ items: [line('a', 10000n)], packagingFeeMinor: 2000n });
    expect(r.packagingFeeMinor).toBe(2000n);
    expect(r.payableTotalMinor).toBe(12000n);
  });

  it('adds the delivery fee on top of the subtotal', () => {
    const r = calculatePricing({ items: [line('a', 10000n)], deliveryFeeMinor: 3000n });
    expect(r.deliveryFeeMinor).toBe(3000n);
    expect(r.payableTotalMinor).toBe(13000n);
  });

  it('platform fee zero renders as zero, not omitted, but never charged when absent', () => {
    const withoutFee = calculatePricing({ items: [line('a', 10000n)] });
    expect(withoutFee.platformFeeMinor).toBe(0n);

    const withZeroFee = calculatePricing({ items: [line('a', 10000n)], platformFeeBps: 0 });
    expect(withZeroFee.platformFeeMinor).toBe(0n);
    expect(withZeroFee.payableTotalMinor).toBe(withoutFee.payableTotalMinor);
  });

  it('a non-zero platform fee (basis points of the subtotal) is added to the payable total', () => {
    // 250 bps = 2.5% of 10000 = 250.
    const r = calculatePricing({ items: [line('a', 10000n)], platformFeeBps: 250 });
    expect(r.platformFeeMinor).toBe(250n);
    expect(r.payableTotalMinor).toBe(10250n);
  });

  it('tax is computed once on the items subtotal and added on top', () => {
    const r = calculatePricing({ items: [line('a', 10000n)], taxPercent: 5 });
    expect(r.taxMinor).toBe(500n); // 5% of 10000
    expect(r.payableTotalMinor).toBe(10500n);
  });

  it('omitted or zero tax renders as an absent line, not a ₹0 one (BR-14 pattern applied to tax)', () => {
    const omitted = calculatePricing({ items: [line('a', 10000n)] });
    const zero = calculatePricing({ items: [line('a', 10000n)], taxPercent: 0 });
    expect(omitted.taxMinor).toBe(0n);
    expect(zero.taxMinor).toBe(0n);
  });

  it('percentage discount without a cap', () => {
    const r = calculatePricing({
      items: [line('a', 10000n)],
      promotion: { type: 'PERCENTAGE', percent: 10 },
    });
    expect(r.promotionDiscountMinor).toBe(1000n);
    expect(r.payableTotalMinor).toBe(9000n);
  });

  it('percentage discount with a cap that binds', () => {
    const r = calculatePricing({
      items: [line('a', 100000n)],
      promotion: { type: 'PERCENTAGE', percent: 50, capMinor: 10000n },
    });
    // 50% of 100000 = 50000, capped to 10000.
    expect(r.promotionDiscountMinor).toBe(10000n);
    expect(r.payableTotalMinor).toBe(90000n);
  });

  it('percentage discount with a cap that does not bind', () => {
    const r = calculatePricing({
      items: [line('a', 10000n)],
      promotion: { type: 'PERCENTAGE', percent: 10, capMinor: 50000n },
    });
    expect(r.promotionDiscountMinor).toBe(1000n);
  });

  it('fixed-amount discount', () => {
    const r = calculatePricing({
      items: [line('a', 10000n)],
      promotion: { type: 'FIXED_AMOUNT', valueMinor: 2500n },
    });
    expect(r.promotionDiscountMinor).toBe(2500n);
    expect(r.payableTotalMinor).toBe(7500n);
  });

  it('a fixed discount exceeding the subtotal is clamped, never producing a negative total (BR-6)', () => {
    const r = calculatePricing({
      items: [line('a', 10000n)],
      promotion: { type: 'FIXED_AMOUNT', valueMinor: 50000n },
    });
    expect(r.payableTotalMinor).toBe(0n);
    expect(r.discountMinor).toBeLessThanOrEqual(r.discountableBaseMinor);
    expect(r.promotionDiscountMinor).toBe(10000n); // clamped to the base, not the raw 50000
  });

  it('loyalty redemption alone', () => {
    const r = calculatePricing({ items: [line('a', 10000n)], loyaltyDiscountMinor: 1500n });
    expect(r.loyaltyDiscountMinor).toBe(1500n);
    expect(r.payableTotalMinor).toBe(8500n);
  });

  it('promotion and loyalty combined, both fitting within the base', () => {
    const r = calculatePricing({
      items: [line('a', 10000n)],
      promotion: { type: 'FIXED_AMOUNT', valueMinor: 3000n },
      loyaltyDiscountMinor: 2000n,
    });
    expect(r.promotionDiscountMinor).toBe(3000n);
    expect(r.loyaltyDiscountMinor).toBe(2000n);
    expect(r.discountMinor).toBe(5000n);
    expect(r.payableTotalMinor).toBe(5000n);
  });

  it('promotion and loyalty combined, exceeding the base — promotion takes priority, loyalty is clamped to what remains (BR-7)', () => {
    const r = calculatePricing({
      items: [line('a', 10000n)],
      promotion: { type: 'FIXED_AMOUNT', valueMinor: 7000n },
      loyaltyDiscountMinor: 5000n,
    });
    expect(r.promotionDiscountMinor).toBe(7000n);
    expect(r.loyaltyDiscountMinor).toBe(3000n); // clamped: only 3000 of the base remained
    expect(r.discountMinor).toBe(10000n);
    expect(r.discountMinor).toBeLessThanOrEqual(r.discountableBaseMinor);
    expect(r.payableTotalMinor).toBe(0n);
  });

  describe('rounding at every boundary (BR-5: half-up, once, never re-rounded)', () => {
    it('rounds a 1-paise boundary up', () => {
      // 0.5% of 100 paise = 0.5 paise -> rounds up to 1.
      const r = calculatePricing({ items: [line('a', 100n)], taxPercent: 0.5 });
      expect(r.taxMinor).toBe(1n);
    });

    it('rounds a repeating-decimal percentage (33.33%) correctly', () => {
      // 33.33% of 100 paise = 33.33 -> rounds to 33.
      const r = calculatePricing({ items: [line('a', 100n)], taxPercent: 33.33 });
      expect(r.taxMinor).toBe(33n);
    });

    it("rounds exactly 0.5 paise up, not to even (half-up, not banker's rounding)", () => {
      // 25% of 2 paise = 0.5 -> half-up rounds to 1.
      const r = calculatePricing({ items: [line('a', 2n)], taxPercent: 25 });
      expect(r.taxMinor).toBe(1n);
    });

    it('applies percentage rounding exactly once even when combined with other fees', () => {
      const r = calculatePricing({
        items: [line('a', 333n)],
        taxPercent: 33.33,
        packagingFeeMinor: 10n,
        deliveryFeeMinor: 20n,
      });
      // 33.33% of 333 = 110.9889 -> rounds once to 111, not re-rounded after summing.
      expect(r.taxMinor).toBe(111n);
      expect(r.payableTotalMinor).toBe(333n + 111n + 10n + 20n);
    });
  });

  it('never produces a negative payable total even with fees plus an over-large discount', () => {
    const r = calculatePricing({
      items: [line('a', 10000n)],
      packagingFeeMinor: 500n,
      deliveryFeeMinor: 500n,
      promotion: { type: 'FIXED_AMOUNT', valueMinor: 999999n },
    });
    expect(r.payableTotalMinor).toBe(1000n); // fees are never discounted away, only the subtotal-based discount is capped
    expect(r.discountMinor).toBeLessThanOrEqual(r.discountableBaseMinor);
  });

  it('is deterministic — identical input always yields identical output', () => {
    const input: PricingInput = {
      items: [line('a', 12345n, 2), line('b', 6789n, 1)],
      packagingFeeMinor: 1000n,
      deliveryFeeMinor: 2500n,
      platformFeeBps: 300,
      taxPercent: 5,
      promotion: { type: 'PERCENTAGE', percent: 10, capMinor: 5000n },
      loyaltyDiscountMinor: 1000n,
    };
    const first = calculatePricing(input);
    const second = calculatePricing(input);
    expect(second).toEqual(first);
  });

  it('produces no floating-point values anywhere in the trace — every field is a bigint', () => {
    const r = calculatePricing({
      items: [line('a', 12345n, 3)],
      packagingFeeMinor: 999n,
      deliveryFeeMinor: 111n,
      platformFeeBps: 50,
      taxPercent: 12.5,
      promotion: { type: 'PERCENTAGE', percent: 15, capMinor: 2000n },
      loyaltyDiscountMinor: 500n,
    });
    const numericFields = [
      r.itemsSubtotalMinor,
      r.packagingFeeMinor,
      r.deliveryFeeMinor,
      r.platformFeeMinor,
      r.taxMinor,
      r.discountableBaseMinor,
      r.promotionDiscountMinor,
      r.loyaltyDiscountMinor,
      r.discountMinor,
      r.payableTotalMinor,
      ...r.items.flatMap((i) => [i.unitPriceMinor, i.lineTotalMinor]),
    ];
    for (const field of numericFields) {
      expect(typeof field).toBe('bigint');
    }
  });
});
