import { z } from 'zod';
import { UpsertAddressDto } from '../../restaurants/dto/upsert-address.dto.js';
import { UpsertBrandingDto } from '../../restaurants/dto/upsert-branding.dto.js';

const SLUG_INPUT_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Admin-side restaurant creation (Phase 22, docs/06 BR-165-BR-168) — a
 * superset of CreateRestaurantDto's own fields plus an optional
 * owner-resolution input. `ownerEmail`/`ownerPhone` are both optional and
 * either may be supplied — see AdminRestaurantContentService.resolveOwner
 * for the fallback-to-placeholder behavior when neither is given or
 * neither matches an existing account. `address`/`branding` are optional
 * so an admin can create a bare-minimum listing mid-call and fill the
 * rest in afterward via the profile/branding edit endpoints.
 */
export const AdminCreateRestaurantDto = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().toLowerCase().min(3).max(63).regex(SLUG_INPUT_PATTERN).optional(),
  description: z.string().trim().max(2000).optional(),
  phone: z.string().trim().min(1).max(20).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  ownerEmail: z.string().trim().toLowerCase().email().optional(),
  ownerPhone: z.string().trim().min(1).max(20).optional(),
  address: UpsertAddressDto.optional(),
  branding: UpsertBrandingDto.optional(),
});

export type AdminCreateRestaurantInput = z.infer<typeof AdminCreateRestaurantDto>;
