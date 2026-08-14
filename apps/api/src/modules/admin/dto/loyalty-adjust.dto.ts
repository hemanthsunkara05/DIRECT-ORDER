import { z } from 'zod';

export const LoyaltyAdjustDto = z.object({
  points: z.number().int().refine((n) => n !== 0, 'points must be non-zero'),
  reason: z.string().trim().min(1).max(500),
});

export type LoyaltyAdjustInput = z.infer<typeof LoyaltyAdjustDto>;
