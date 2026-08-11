import { z } from 'zod';

/**
 * Deliberately narrower than `PromotionCreateDto` — `code`, `type`,
 * `value`, `restaurantId`, and `firstOrderOnly` are not updatable here.
 * Changing what a coupon fundamentally IS after it may already have
 * live redemptions is closer to "delete and recreate" than "manage";
 * the fields exposed here are the ones a restaurant/admin genuinely
 * needs to adjust operationally (pause it, extend/shorten its window,
 * tighten its limits) without altering the offer past-redeemers relied
 * on (docs/03-state-machines.md §7.7, INV-8: past orders are
 * unaffected by later promotion changes).
 */
export const PromotionUpdateDto = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  maxDiscountMinor: z.coerce.bigint().nonnegative().nullable().optional(),
  usageLimitTotal: z.coerce.number().int().positive().nullable().optional(),
  usageLimitPerCustomer: z.coerce.number().int().positive().nullable().optional(),
});

export type PromotionUpdateInput = z.infer<typeof PromotionUpdateDto>;
