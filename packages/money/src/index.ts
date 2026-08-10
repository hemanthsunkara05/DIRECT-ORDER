/**
 * @direct-order/money
 *
 * The ONLY place money arithmetic happens in this codebase (INV-1, BR-1).
 * Every monetary value is an integer number of minor units (paise for
 * INR) represented as a native BigInt. There is no floating-point
 * representation of money anywhere in this package, and callers must
 * never introduce one — see PRODUCT/docs/12-repository-structure.md §19.3
 * and the repo-wide ESLint rules in packages/config/eslint/base.js that
 * ban Math.round/.toFixed/parseFloat outside this file.
 */

/** An amount of money in integer minor units (e.g. paise for INR). */
export type Minor = bigint;

const DECIMAL_STRING_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/**
 * Parses a decimal rupee string into integer paise.
 *
 * `toMinor("250.50")` -> `25050n`
 * `toMinor("250")`    -> `25000n`
 * `toMinor("-10.05")` -> `-1005n`
 *
 * The parameter type is `string`, not `number` — this is deliberate.
 * A JavaScript `number` literal like `250.50` cannot exactly represent
 * every two-decimal rupee value (classic 0.1 + 0.2 problem), so passing
 * one is a compile-time type error by construction, not a runtime check.
 * Money always enters this package as a string (from a form field, a
 * request body validated by Zod as a string, or already-integer paise).
 *
 * @throws {TypeError} if the input is not a valid decimal string with at
 *   most two fractional digits.
 */
export function toMinor(rupees: string): Minor {
  if (typeof rupees !== 'string') {
    // Guards the boundary at runtime too (e.g. an `any`-typed value from
    // JSON.parse reaching here) even though the type system already
    // prevents this for statically-typed callers.
    throw new TypeError(`toMinor() requires a string, received ${typeof rupees}`);
  }

  const trimmed = rupees.trim();
  if (!DECIMAL_STRING_PATTERN.test(trimmed)) {
    throw new TypeError(
      `toMinor() received an invalid decimal string: ${JSON.stringify(rupees)}. ` +
        'Expected an optional leading "-" followed by digits and at most two decimal places.',
    );
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  // The regex above guarantees at least one leading digit, so `wholePart`
  // is never actually empty at runtime; the '0' fallback exists only to
  // satisfy noUncheckedIndexedAccess on the array-destructure.
  const [wholePart = '0', fractionPartRaw = ''] = unsigned.split('.');
  const fractionPart = fractionPartRaw.padEnd(2, '0');

  const whole = BigInt(wholePart);
  const fraction = BigInt(fractionPart);
  const minor = whole * 100n + fraction;

  return negative ? -minor : minor;
}

/**
 * Formats integer paise as an Indian-grouped rupee string.
 *
 * `formatINR(25050n)`    -> "₹250.50"
 * `formatINR(1234567n)`  -> "₹12,345.67"
 * `formatINR(-50000n)`   -> "-₹500.00"
 *
 * Implemented entirely with BigInt division/modulo — never converts the
 * amount to a `number`, so there is no precision loss at any magnitude.
 */
export function formatINR(amountMinor: Minor): string {
  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;

  const rupees = abs / 100n;
  const paise = abs % 100n;

  const groupedRupees = groupIndianDigits(rupees.toString());
  const paiseStr = paise.toString().padStart(2, '0');

  return `${negative ? '-' : ''}₹${groupedRupees}.${paiseStr}`;
}

/**
 * Groups a non-negative integer digit string using the Indian numbering
 * system: the last three digits together, then groups of two from the
 * right. "1234567" -> "12,34,567".
 */
function groupIndianDigits(digits: string): string {
  if (digits.length <= 3) {
    return digits;
  }

  const lastThree = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];

  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) {
    groups.unshift(rest);
  }

  return [...groups, lastThree].join(',');
}

/**
 * Computes `percent`% of `amountMinor`, rounded half-up to the nearest
 * paise, applied exactly once (BR-5). Deterministic: the same inputs
 * always produce the same output.
 *
 * `percentageOf(10000n, 12.5)` -> `1250n`  (12.5% of ₹100.00 = ₹12.50)
 * `percentageOf(100n, 33.33)`  -> `33n`    (33.33% of ₹1.00, rounds to 33 paise)
 */
export function percentageOf(amountMinor: Minor, percent: number): Minor {
  if (!Number.isFinite(percent)) {
    throw new TypeError(`percentageOf() received a non-finite percent: ${percent}`);
  }

  // Converts the *rate* (not a monetary amount) to integer hundredths-of-
  // a-percent so the actual monetary rounding below can be done with
  // exact BigInt arithmetic. This is the one intentional, narrow
  // exception to the repo-wide "no Math.round" lint rule: the value
  // being rounded here is a percentage input (e.g. a tax or discount
  // rate configured by an admin), never a paise amount. The monetary
  // rounding itself — the half-up division two lines down — is exact
  // integer arithmetic with no floating-point step.
  // eslint-disable-next-line no-restricted-syntax -- not money: rounding a percent rate to integer basis points, see comment above
  const percentHundredths = BigInt(Math.round(percent * 100));

  const scaled = amountMinor * percentHundredths;
  const divisor = 10000n; // 100 (percent scale) * 100 (percent-hundredths scale)

  // Half-up rounding for both positive and negative amounts.
  if (scaled >= 0n) {
    return (scaled + divisor / 2n) / divisor;
  }
  return -((-scaled + divisor / 2n) / divisor);
}

/**
 * Sums any number of Minor values. `sum()` with no arguments is `0n`.
 */
export function sum(...values: Minor[]): Minor {
  return values.reduce((total, value) => total + value, 0n);
}

// The pricing engine (Phase 8) imports percentageOf/sum/Minor from this
// file — re-exported here rather than merged in, so this file stays
// the primitives (toMinor/formatINR/percentageOf/sum) and pricing.ts
// stays the domain-shaped calculation built on top of them.
export * from './pricing.js';
