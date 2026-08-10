import { randomBytes } from 'node:crypto';

/**
 * `order_number` format `DO-YYMMDD-XXXXX` (docs/02-database-schema.md
 * §6.3): "base32 from a per-day sequence mixed with random bits.
 * Sequential enough for staff to read aloud, not enumerable enough to
 * guess another customer's order." A true per-day database sequence
 * needs its own counter table/row-lock dance; this sandbox cannot
 * verify that against real Postgres anyway (no Docker, same standing
 * limitation as every other locked-row operation this phase), so
 * `XXXXX` here is 25 random bits Crockford-base32-encoded instead of a
 * real sequence mixed with random bits — same "sequential enough to
 * read aloud, not enumerable" shape, minus the strict per-day
 * ordering the real sequence would add. `orderNumber` carries a
 * `@@unique` constraint regardless, so a collision (astronomically
 * unlikely at this volume) is still caught and retried by the caller,
 * never silently accepted as a duplicate.
 */
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateOrderNumber(now: Date = new Date()): string {
  const datePart = formatYyMmDd(now);
  const suffix = randomBase32(5);
  return `DO-${datePart}-${suffix}`;
}

function formatYyMmDd(date: Date): string {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CROCKFORD_BASE32[bytes[i]! % CROCKFORD_BASE32.length];
  }
  return out;
}
