import { z } from 'zod';

export const UpsertAddressDto = z.object({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  locality: z.string().trim().max(100).optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(20),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  landmark: z.string().trim().max(200).optional(),
});

export type UpsertAddressInput = z.infer<typeof UpsertAddressDto>;
