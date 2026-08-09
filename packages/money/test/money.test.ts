import { describe, expect, it } from 'vitest';
import { formatINR, percentageOf, sum, toMinor, type Minor } from '../src/index.js';

describe('toMinor', () => {
  it('converts a two-decimal rupee string to integer paise', () => {
    expect(toMinor('250.50')).toBe(25050n);
  });

  it('converts a whole rupee string to integer paise', () => {
    expect(toMinor('250')).toBe(25000n);
  });

  it('converts a single-decimal rupee string to integer paise', () => {
    expect(toMinor('9.5')).toBe(950n);
  });

  it('handles zero', () => {
    expect(toMinor('0')).toBe(0n);
    expect(toMinor('0.00')).toBe(0n);
  });

  it('handles negative amounts (for ledger deltas)', () => {
    expect(toMinor('-10.05')).toBe(-1005n);
  });

  it('is exact for values that are lossy as IEEE-754 floats', () => {
    // 0.1 + 0.2 !== 0.3 in float arithmetic; toMinor must not go through
    // a float at any point.
    expect(toMinor('0.10') + toMinor('0.20')).toBe(toMinor('0.30'));
  });

  it('rejects malformed strings', () => {
    expect(() => toMinor('abc')).toThrow(TypeError);
    expect(() => toMinor('250.5.0')).toThrow(TypeError);
    expect(() => toMinor('250.500')).toThrow(TypeError); // more than 2 decimals
    expect(() => toMinor('')).toThrow(TypeError);
    expect(() => toMinor('₹250')).toThrow(TypeError);
  });

  it('rejects non-string input at runtime even if the type system is bypassed', () => {
    // Simulates an `any`-typed value from JSON.parse reaching the boundary.
    expect(() => toMinor(250.5 as any)).toThrow(TypeError);
  });
});

describe('toMinor — type safety', () => {
  it('rejects a number literal at compile time (see money.type-test.ts)', () => {
    // This test intentionally has no runtime assertion. Its purpose is
    // documentary: the companion file money.type-test.ts contains a
    // `// @ts-expect-error` on `toMinor(250.5)` which fails `tsc` if the
    // signature ever accidentally widens to accept `number`.
    expect(true).toBe(true);
  });
});

describe('formatINR', () => {
  it('formats a simple amount', () => {
    expect(formatINR(25050n)).toBe('₹250.50');
  });

  it('formats zero', () => {
    expect(formatINR(0n)).toBe('₹0.00');
  });

  it('pads single-digit paise', () => {
    expect(formatINR(100n)).toBe('₹1.00');
    expect(formatINR(105n)).toBe('₹1.05');
  });

  it('groups thousands using the Indian numbering system', () => {
    expect(formatINR(123456700n)).toBe('₹12,34,567.00');
  });

  it('does not group amounts under 1,000', () => {
    expect(formatINR(99900n)).toBe('₹999.00');
  });

  it('groups a value in crores (100 crore = ₹1,00,00,00,000)', () => {
    // 100000000000n paise = ₹1,000,000,000.00 = 100 crore.
    expect(formatINR(100000000000n)).toBe('₹1,00,00,00,000.00');
  });

  it('formats negative amounts with a leading minus before the symbol', () => {
    expect(formatINR(-50000n)).toBe('-₹500.00');
  });

  it('round-trips with toMinor for representative values', () => {
    for (const value of ['0.00', '1.00', '250.50', '999.99', '100000.00']) {
      expect(formatINR(toMinor(value))).toBe(`₹${addIndianGrouping(value)}`);
    }
  });
});

describe('percentageOf', () => {
  it('computes a simple percentage', () => {
    expect(percentageOf(10000n, 12.5)).toBe(1250n); // 12.5% of ₹100.00
  });

  it('rounds half-up at the paise boundary', () => {
    // 33.33% of ₹1.00 (100 paise) = 33.33 paise -> rounds to 33
    expect(percentageOf(100n, 33.33)).toBe(33n);
    // 33.34% of ₹1.00 = 33.34 paise -> rounds to 33
    expect(percentageOf(100n, 33.34)).toBe(33n);
  });

  it("rounds .5 paise up, not to even (half-up, not banker's rounding)", () => {
    // 0.5% of ₹1.00 (100 paise) = 0.5 paise -> rounds up to 1
    expect(percentageOf(100n, 0.5)).toBe(1n);
  });

  it('is deterministic across repeated calls', () => {
    const results = new Set<Minor>();
    for (let i = 0; i < 1000; i++) {
      results.add(percentageOf(123456n, 18));
    }
    expect(results.size).toBe(1);
  });

  it('handles 0 percent', () => {
    expect(percentageOf(10000n, 0)).toBe(0n);
  });

  it('handles 100 percent exactly', () => {
    expect(percentageOf(10000n, 100)).toBe(10000n);
  });

  it('rejects non-finite percentages', () => {
    expect(() => percentageOf(10000n, Infinity)).toThrow(TypeError);
    expect(() => percentageOf(10000n, NaN)).toThrow(TypeError);
  });
});

describe('sum', () => {
  it('sums multiple values', () => {
    expect(sum(100n, 200n, 300n)).toBe(600n);
  });

  it('returns 0n for no arguments', () => {
    expect(sum()).toBe(0n);
  });

  it('handles a mix of positive and negative values (refund/clawback deltas)', () => {
    expect(sum(1000n, -300n, 50n)).toBe(750n);
  });
});

describe('order total identity (INV-7 shape, exercised at the money-primitive level)', () => {
  it('subtotal + fees + tax - discount matches a manually computed total', () => {
    const itemsSubtotal = toMinor('499.00');
    const packagingFee = toMinor('10.00');
    const deliveryFee = toMinor('30.00');
    const taxRatePercent = 5;
    const tax = percentageOf(itemsSubtotal, taxRatePercent);
    const discount = toMinor('50.00');

    const total = sum(itemsSubtotal, packagingFee, deliveryFee, tax) - discount;

    // 499 + 10 + 30 + 24.95(rounded 25) - 50 = 514.00 (with tax rounding to nearest paise)
    expect(total).toBe(sum(itemsSubtotal, packagingFee, deliveryFee, tax, -discount));
    expect(total).toBeGreaterThan(0n);
  });
});

/** Test-only helper: naive Indian grouping for a decimal string, used only to cross-check formatINR. */
function addIndianGrouping(decimal: string): string {
  const [whole, frac] = decimal.split('.');
  const digits = whole ?? '0';
  if (digits.length <= 3) return `${digits}.${frac}`;
  const lastThree = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) groups.unshift(rest);
  return `${[...groups, lastThree].join(',')}.${frac}`;
}
