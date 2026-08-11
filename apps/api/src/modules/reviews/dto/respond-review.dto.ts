import { z } from 'zod';

/** BR-122: one public response per review — the DTO only carries the body; uniqueness is the DB constraint's job. */
export const RespondReviewDto = z.object({
  body: z.string().trim().min(1).max(2000),
});

export type RespondReviewInput = z.infer<typeof RespondReviewDto>;
