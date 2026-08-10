import { z } from 'zod';

/**
 * `POST /public/carts` (docs/04-api-specification.md §8.3). Same item
 * shape as Phase 8's `QuoteCartDto` — a cart line is a cart line
 * whether it's being priced inline or persisted.
 */
export const CreateCartDto = z.object({
  restaurantSlug: z.string().trim().min(1),
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(99),
        unitPriceMinorAtAdd: z.coerce.bigint().positive(),
      }),
    )
    .min(1, 'Cart must contain at least one item.')
    .max(100),
});

export type CreateCartInput = z.infer<typeof CreateCartDto>;
