import { z } from 'zod';

/**
 * BR-119: rating is a server-validated integer 1-5. `body` is optional
 * (a bare star rating is a valid review) and stored verbatim — BR-120's
 * "untrusted, never rendered as HTML" is a frontend-rendering
 * guarantee (React's default text escaping, no `dangerouslySetInnerHTML`
 * anywhere reviews are shown), not a server-side sanitization step; see
 * `Review`'s own schema doc comment.
 */
export const SubmitReviewDto = z.object({
  token: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().max(2000).optional(),
});

export type SubmitReviewInput = z.infer<typeof SubmitReviewDto>;
