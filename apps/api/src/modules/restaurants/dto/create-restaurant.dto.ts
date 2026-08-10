import { z } from 'zod';

/**
 * Deliberately has no `ownerId`, `status`, or `onboardingStatus` field —
 * ownership is always the authenticated principal
 * (docs/14-acceptance-criteria.md: "POST /restaurants with ownerId set
 * to another user creates the restaurant owned by the authenticated
 * user"), and lifecycle fields are never client-writable.
 *
 * `slug` IS client-writable, and optional: a wizard UI can suggest one
 * from `name` and let the owner confirm/edit it before submitting
 * (docs/01-domain-model.md §5.2's slug constraints — format, reserved
 * words, uniqueness — only mean anything as a REJECTION path if a
 * client can actually propose a slug; docs/14-acceptance-criteria.md's
 * "a reserved slug is rejected with a clear message" requires exactly
 * that). Omitting it falls back to auto-derivation with silent
 * disambiguation (RestaurantService.generateUniqueSlug) — a client that
 * doesn't care about its URL doesn't have to.
 */
const SLUG_INPUT_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const CreateRestaurantDto = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().toLowerCase().min(3).max(63).regex(SLUG_INPUT_PATTERN).optional(),
  description: z.string().trim().max(2000).optional(),
  phone: z.string().trim().min(1).max(20).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

export type CreateRestaurantInput = z.infer<typeof CreateRestaurantDto>;
