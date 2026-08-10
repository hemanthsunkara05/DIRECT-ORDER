import { z } from 'zod';

export const ToggleOrderingDto = z.object({
  orderingEnabled: z.boolean(),
});

export type ToggleOrderingInput = z.infer<typeof ToggleOrderingDto>;
