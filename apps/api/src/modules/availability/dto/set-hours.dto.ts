import { z } from 'zod';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `PUT /restaurant/hours` — the full replacement weekly schedule. Multiple entries per `dayOfWeek` are split shifts (docs/01-domain-model.md §5.2). */
export const SetHoursDto = z.object({
  days: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        opensAt: z.string().regex(TIME_PATTERN),
        closesAt: z.string().regex(TIME_PATTERN),
        isClosed: z.boolean().optional(),
      }),
    )
    .max(100),
});

export type SetHoursInput = z.infer<typeof SetHoursDto>;
