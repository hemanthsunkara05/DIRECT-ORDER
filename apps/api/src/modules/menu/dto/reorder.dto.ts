import { z } from 'zod';

/**
 * Shared by both the category and item reorder endpoints
 * (docs/04-api-specification.md §8.5: `POST /restaurant/menu/categories/reorder`,
 * `POST /restaurant/menu/items/reorder`). `displayOrder` is the FULL new
 * ordering the client computed after a drag (or a keyboard move) — the
 * service applies every entry inside one transaction, so a request
 * naming an id outside the caller's tenant fails the whole batch rather
 * than partially reordering (docs/14-acceptance-criteria.md, Phase 6:
 * "a partial failure leaves the previous order intact").
 */
export const ReorderDto = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        displayOrder: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(500),
});

export type ReorderInput = z.infer<typeof ReorderDto>;
