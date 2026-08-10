import { z } from 'zod';

const DIETARY_TAGS = ['VEG', 'NON_VEG', 'EGG', 'UNKNOWN'] as const;

/**
 * `priceMinor` is integer paise (`*Minor` — INV-1), coerced from either a
 * JSON string or number to `bigint`. `z.coerce.bigint()` throws on
 * non-numeric input ("abc") the same way `BigInt("abc")` does, and
 * `.positive()` rejects both `0` and negative values — together these
 * satisfy the Phase 6 acceptance criterion verbatim ("Price 0, negative,
 * and 'abc' are all rejected server-side").
 */
export const CreateItemDto = z.object({
  categoryId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  priceMinor: z.coerce.bigint().positive(),
  imageUrl: z.string().trim().url().max(2000).optional(),
  dietaryTag: z.enum(DIETARY_TAGS).optional(),
});

export type CreateItemInput = z.infer<typeof CreateItemDto>;
