import type { User } from '@prisma/client';
import type { PrismaService } from './database/prisma.service.js';

/**
 * The single account that technically "owns" every unclaimed preview
 * listing (outreach-batch restaurants seeded without a real owner) —
 * has no passwordHash, so nothing can ever log into it. A restaurant
 * owned only by this account is, by definition, unclaimed: there is no
 * schema field for it, since "unclaimed" IS "owned by this account and
 * nothing else." Shared between RestaurantService (claim) and the admin
 * outreach list so both agree on exactly the same definition.
 */
export const UNCLAIMED_PLACEHOLDER_EMAIL = 'unclaimed-listings@direct-order.local';

/**
 * Lazily finds or creates the placeholder account (Phase 22, docs/06
 * BR-167). Before this phase, nothing in this codebase actually created
 * this row — only manual test fixtures and out-of-repo outreach scripts
 * ever had — so a fresh or production environment may have none yet.
 * `AdminRestaurantContentService.create()` is the first code path that
 * needs this row to exist reliably, so it finds-or-creates rather than
 * assuming it's pre-seeded. Idempotent: a second call finds the row the
 * first call created. `claimRestaurant()` is intentionally left as-is —
 * its existing "no placeholder found" behavior is a separate, pre-existing
 * concern out of this phase's scope.
 */
export async function getOrCreateUnclaimedPlaceholder(prisma: PrismaService): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { email: UNCLAIMED_PLACEHOLDER_EMAIL } });
  if (existing) return existing;
  return prisma.user.create({
    data: { email: UNCLAIMED_PLACEHOLDER_EMAIL, fullName: 'Unclaimed Listing', status: 'ACTIVE' },
  });
}
