/**
 * Slug format and reserved-word rules (docs/01-domain-model.md §5.2):
 * lowercase alphanumeric with hyphens, 3–63 chars, checked against a
 * reserved-word list. Uniqueness (the third and last check) needs a
 * database round trip and lives in RestaurantRepository, not here —
 * this file is pure and unit-testable without Prisma.
 */

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MIN_LENGTH = 3;
const MAX_LENGTH = 63;

export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'support',
  'app',
  'www',
  'r',
  'static',
  'assets',
  'health',
]);

export type SlugValidationIssue = 'TOO_SHORT' | 'TOO_LONG' | 'INVALID_FORMAT' | 'RESERVED';

/** Returns every issue found — empty array means the slug is well-formed and not reserved (uniqueness still unchecked). */
export function validateSlugFormat(slug: string): SlugValidationIssue[] {
  const issues: SlugValidationIssue[] = [];

  if (slug.length < MIN_LENGTH) issues.push('TOO_SHORT');
  if (slug.length > MAX_LENGTH) issues.push('TOO_LONG');
  if (!SLUG_PATTERN.test(slug)) issues.push('INVALID_FORMAT');
  if (RESERVED_SLUGS.has(slug)) issues.push('RESERVED');

  return issues;
}

/**
 * Derives a candidate slug from a restaurant name (lowercase, spaces
 * and disallowed characters collapsed to single hyphens, trimmed of
 * leading/trailing hyphens) — a starting point for RestaurantService
 * to check for uniqueness and disambiguate (append -2, -3, ...) against,
 * not a validated final slug on its own.
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents after NFKD decomposition
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (base.length < MIN_LENGTH) {
    // Pad rather than reject — this is a suggestion, not user input;
    // a 1-2 char name (unusual but not invalid as a *name*) still needs
    // a slug candidate to start disambiguation from.
    return `${base}-restaurant`.slice(0, MAX_LENGTH);
  }
  return base.slice(0, MAX_LENGTH).replace(/-+$/, '');
}
