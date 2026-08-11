import { z } from 'zod';

const PROMOTION_TYPES = ['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_DELIVERY'] as const;

/**
 * Shared by both `/restaurant/promotions` and `/admin/promotions`.
 * `restaurantId` is only ever read by the admin controller — the
 * restaurant controller always derives it from the caller's own tenant
 * membership and never trusts this field, the same "ownerId in the
 * body is ignored" pattern Phase 5 established for restaurant creation.
 */
export const PromotionCreateDto = z
  .object({
    restaurantId: z.string().uuid().nullable().optional(),
    code: z
      .string()
      .trim()
      .min(3)
      .max(50)
      .regex(/^[A-Za-z0-9_-]+$/, 'Coupon codes may only contain letters, digits, - and _.'),
    name: z.string().trim().min(1).max(200),
    type: z.enum(PROMOTION_TYPES),
    /** PERCENTAGE: 1-100. FIXED_AMOUNT/FREE_DELIVERY: minor-unit amount — see `Promotion.value`'s schema comment for FREE_DELIVERY's advisory-only meaning. */
    value: z.coerce.number().int().positive(),
    minOrderMinor: z.coerce.bigint().nonnegative().optional(),
    maxDiscountMinor: z.coerce.bigint().nonnegative().optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    usageLimitTotal: z.coerce.number().int().positive().optional(),
    usageLimitPerCustomer: z.coerce.number().int().positive().optional(),
    firstOrderOnly: z.boolean().optional(),
  })
  .refine((v) => v.type !== 'PERCENTAGE' || v.value <= 100, {
    message: 'A percentage discount cannot exceed 100.',
    path: ['value'],
  })
  .refine((v) => !v.startsAt || !v.endsAt || v.startsAt.getTime() < v.endsAt.getTime(), {
    message: 'endsAt must be after startsAt.',
    path: ['endsAt'],
  });

export type PromotionCreateInput = z.infer<typeof PromotionCreateDto>;
