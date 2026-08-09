/**
 * Base for any repository whose rows belong to exactly one restaurant
 * tenant (Phase 2 deliverable, PRODUCT/docs/13-implementation-phases.md).
 *
 * This is deliberately not a deep generic wrapper around Prisma's
 * per-model delegate types — fighting Prisma's type system to build one
 * fully-generic `findMany`/`create`/`update` across every model adds a
 * lot of indirection for little real safety. The actual guarantee this
 * phase needs is simpler and stronger: every concrete subclass's PUBLIC
 * methods take `restaurantId` as an explicit, required parameter, so a
 * call site that omits it is an ordinary TypeScript compile error — not
 * a runtime bug waiting to leak one tenant's data to another
 * (PRODUCT/docs/02-database-schema.md §6.5: "every restaurant-scoped
 * query goes through a repository helper that requires a restaurantId
 * argument... no module builds raw tenant queries inline").
 *
 * `withTenant` is the one place `restaurantId` actually gets merged into
 * a Prisma `where` clause, so every subclass method does it identically
 * rather than each hand-rolling `{ ...where, restaurantId }` and
 * risking a typo or an omitted field on one path.
 *
 * See RestaurantStaffRepository for the reference implementation, and
 * tenant-scoped.repository.type-test.ts for the compile-time proof that
 * a restaurantId-less call is rejected.
 */
export abstract class TenantScopedRepository {
  protected withTenant<W extends Record<string, unknown>>(
    restaurantId: string,
    where: W,
  ): W & { restaurantId: string } {
    if (!restaurantId) {
      // Defends against a caller passing an empty string, which would
      // silently satisfy TypeScript's required-parameter check while
      // still producing an unscoped (or wrongly-scoped) query. A real
      // call site should never be able to reach this — it indicates a
      // bug in the calling repository method, not bad external input.
      throw new Error(
        'withTenant() called with an empty restaurantId. This must never happen — check the caller.',
      );
    }
    return { ...where, restaurantId };
  }
}
