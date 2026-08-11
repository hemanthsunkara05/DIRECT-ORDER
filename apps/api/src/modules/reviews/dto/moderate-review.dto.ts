import { z } from 'zod';

const MODERATION_STATUSES = ['PUBLISHED', 'HIDDEN', 'REMOVED'] as const;

/** `POST /admin/reviews/:id/moderate` — reason required and audited (docs/04-api-specification.md §8.7). */
export const ModerateReviewDto = z.object({
  status: z.enum(MODERATION_STATUSES),
  reason: z.string().trim().min(1).max(500),
});

export type ModerateReviewInput = z.infer<typeof ModerateReviewDto>;
