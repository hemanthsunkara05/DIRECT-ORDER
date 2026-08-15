# Runbook: Restore from backup

Covers: genuine data loss/corruption requiring a restore, and the routine drill that keeps this runbook trustworthy. See [DISASTER_RECOVERY.md](../../DISASTER_RECOVERY.md) for the full mechanism, current verified status, and RPO/RTO targets.

## When to use this runbook

- A confirmed data-corruption incident (docs/10 §17.4 rollback trigger: "database corruption").
- A database failover that may have lost the tail of writes (see [database-outage.md](database-outage.md)'s escalation section).
- The routine monthly restore drill required by docs/10 §16.4, to keep the `RESTORE VERIFIED` status honest rather than stale.

**This is a last resort for genuine data loss** — for a bad deploy or bad migration where the data itself is intact, use [bad-deployment.md](bad-deployment.md) instead; docs/10 §17.4 is explicit that migrations should not be blindly reversed and that PITR restore is "a deliberate, approved decision," not a reflexive one.

## Symptoms warranting a real restore

- Data is missing or corrupted in a way that cannot be fixed by replaying events, re-running a job, or a targeted data correction.
- A restore to a specific point in time is the only way to recover a consistent pre-incident state.

## Diagnostic commands (before restoring)

1. Confirm the exact scope of the loss/corruption — which tables, which time window. A narrower incident may be fixable with a targeted correction instead of a full restore.
2. Identify the last known-good point in time to restore to (the RPO target is ≤ 5 minutes, PITR-dependent — confirm the actual achievable granularity with the managed Postgres provider once one is selected).
3. Confirm this decision has the required approval — a database restore is one of the highest-blast-radius actions this system can take and docs/10 explicitly calls it "a deliberate, approved decision."

## Production restore procedure (target mechanism)

Not yet exercised against real production infrastructure (none exists yet — Phase 20 is launch readiness). The target procedure, per docs/10 §16.4:

1. Restore the latest backup (or a specific point-in-time) to a **temporary, separate instance** — never restore in place over the live database first.
2. Run the migrations check against the restored instance to confirm schema consistency.
3. Boot the application against the restored instance and run smoke tests.
4. Only after the restored instance is confirmed healthy, cut traffic over (or use it to extract the specific data needed to correct the live database, if a full cutover isn't warranted).
5. Record the result and duration of the drill/restore.

## The drill actually exercised in this sandbox

This sandbox has no `pg_dump`/`pg_restore`/`psql`/`docker` CLI available, so the drill actually run and verified (`pnpm db:restore-drill`, `scripts/db-restore-drill.mjs`) is a same-server, schema-level substitute: extract real rows from `public`, restore them into a disposable `restore_drill` schema on the same server, verify exact row-count and checksum match, then drop the schema. See [DISASTER_RECOVERY.md](../../DISASTER_RECOVERY.md) for the full writeup, the honest limitation this implies (data-level, not infrastructure-level, recoverability), and the most recent verified result.

To run it:

```bash
DATABASE_URL="<DATABASE_URL>&schema=restore_drill" npx prisma migrate deploy --schema prisma/schema.prisma
pnpm db:restore-drill
```

## Verification

- Every table in the drill's representative set reports `PASS` (row count and checksum both match).
- Final line reads `=== RESTORE VERIFIED ===`, not `=== RESTORE DRILL FAILED ===`. Per docs/13, report `RESTORE VERIFIED` only if a drill has actually passed — never assert this status without a fresh passing run backing it.

## Escalation

- Any restore performed in response to a real incident (not a routine drill): notify stakeholders before and after, given the blast radius, and document the exact restore point chosen and why.
- If a restore drill fails (checksum or row-count mismatch): treat as a P0 — a failing drill means the backup mechanism itself cannot currently be trusted, which undermines every other runbook's "restore from backup" fallback option.
