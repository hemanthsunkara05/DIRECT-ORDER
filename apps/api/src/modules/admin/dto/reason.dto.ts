import { z } from 'zod';

export const ReasonDto = z.object({
  reason: z.string().trim().min(1).max(500),
});

export type ReasonInput = z.infer<typeof ReasonDto>;
