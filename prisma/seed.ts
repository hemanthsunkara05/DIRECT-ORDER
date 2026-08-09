/**
 * Development seed script. Phase 1 has no domain models to seed yet —
 * this is a placeholder proving the `pnpm db:seed` command works end
 * to end. Phase 2 replaces this with real seed data: two restaurants
 * with distinct owners and staff, per
 * PRODUCT/docs/14-acceptance-criteria.md (Phase 2) and
 * PRODUCT/docs/13-implementation-phases.md (Phase 2) — "two
 * restaurants from day one, so isolation is testable from the start."
 */
function main(): void {
  console.log('[seed] No domain models exist yet (Phase 1). Nothing to seed.');
}

try {
  main();
} catch (error: unknown) {
  console.error('[seed] Failed:', error);
  process.exit(1);
}
