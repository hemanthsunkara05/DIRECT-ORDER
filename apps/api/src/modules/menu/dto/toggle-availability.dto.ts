import { z } from 'zod';

export const ToggleAvailabilityDto = z.object({
  isAvailable: z.boolean(),
});

export type ToggleAvailabilityInput = z.infer<typeof ToggleAvailabilityDto>;
