import { z } from 'zod';
import { UpsertAddressDto } from './upsert-address.dto.js';

/**
 * No `slug` — changing the URL identity is a deliberately separate,
 * not-yet-built operation (see restaurant.repository.ts). `address` is
 * nested here rather than a separate endpoint — docs/04-api-specification.md
 * §8.5 lists exactly one row for "Profile" (`GET/PATCH /restaurant/profile`),
 * not a distinct address route, and the relationship is 1:1 either way.
 * Present-but-omitted means "leave as-is"; the address sub-object is
 * only touched when the caller actually sends one.
 */
export const UpdateProfileDto = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  phone: z.string().trim().min(1).max(20).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  address: UpsertAddressDto.optional(),
});

export type UpdateProfileInput = z.infer<typeof UpdateProfileDto>;
