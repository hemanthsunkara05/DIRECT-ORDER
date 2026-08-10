import { z } from 'zod';

export const CreateClosureDto = z.object({
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

export type CreateClosureInput = z.infer<typeof CreateClosureDto>;
