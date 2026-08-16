import { z } from 'zod';

export const ClaimRestaurantDto = z.object({
  slug: z.string().trim().toLowerCase().min(1).max(63),
});

export type ClaimRestaurantInput = z.infer<typeof ClaimRestaurantDto>;
