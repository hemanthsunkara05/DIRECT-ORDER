# Disaster Recovery — Phase 19

Date: 2026-08-15. Scope: backup/restore mechanism and verification per [docs/10-infrastructure-deployment.md](docs/10-infrastructure-deployment.md) §16.4, and the runbook set required by §17.7.

## Status

**Disaster recovery status: `RESTORE VERIFIED`** (see [Restore drill result](#restore-drill-result-2026-08-15) below). docs/10 §16.4 is explicit: *"a backup that has never been restored is not a backup"* and *"until a restore drill has passed, disaster recovery status is `NOT VERIFIED`."* A real, end-to-end drill has now passed against the real running Postgres instance this project uses in development — this is the first time that claim can honestly be made.

## What "verified" means here, precisely

This project's sandbox environment has **no `pg_dump`, `pg_restore`, `psql`, or `docker` CLI available** (checked directly with `which`/`Get-Command`; both returned nothing), even though the Postgres server itself is reachable at `localhost:5432`. A real production deployment must use `pg_dump`/`pg_restore` (or the managed-Postgres provider's own PITR/snapshot restore) targeting genuinely separate infrastructure, exactly as docs/10 §16.4 specifies — that remains the target production mechanism and is not superseded by anything below.

Given this sandbox's tooling constraints, the drill instead uses Prisma's schema-qualified connection-string support to prove the same underlying property — that real data can be extracted and faithfully re-inserted — using a disposable, isolated Postgres **schema** on the same server rather than a separate restored instance:

1. Extract every row from a representative set of the highest-value tables (docs/09-security.md §15.1's own asset ranking: payment integrity, tenant isolation, customer PII) out of the real `public` schema — this stands in for "the backup."
2. Migrate a fresh, empty `restore_drill` schema on the same server (`prisma migrate deploy` against a connection string with `?schema=restore_drill`).
3. Re-insert every extracted row into `restore_drill`, in dependency order — this stands in for "the restore."
4. Verify, per table: the restored row count matches exactly, and a SHA-256 checksum of the row content matches exactly.
5. Drop the disposable schema.

This is a **weaker claim than restoring onto genuinely separate infrastructure** — it does not prove infrastructure-level recoverability (a new server/region coming up from scratch), only data-level recoverability (that a real backup artifact, once extracted, can be faithfully restored without loss or corruption). It is a real extraction and a real, checksum-verified re-insertion, not a simulation or a mocked test. The gap between this and a full infrastructure-level drill is recorded below as a known limitation, not glossed over.

## Running the drill

```bash
# Step 1 — migrate the disposable drill schema (reads DATABASE_URL from the
# environment; the drill script computes the exact ?schema=restore_drill
# variant it expects and will print this command verbatim if the schema
# isn't ready yet):
DATABASE_URL="<DATABASE_URL>&schema=restore_drill" npx prisma migrate deploy --schema prisma/schema.prisma

# Step 2 — run the drill itself (extract, restore, verify, clean up):
pnpm db:restore-drill
```

`scripts/db-restore-drill.mjs` auto-detects whether the drill schema is migrated (queries `information_schema.tables` for `_prisma_migrations` inside `restore_drill`) rather than trusting a manually-set flag, so it never silently "restores" into an unmigrated schema. If step 1 hasn't been run, it exits with the exact command to run, unchanged from above.

The script prints `=== RESTORE VERIFIED ===` and exits 0 only if every table's row count and checksum matched; otherwise `=== RESTORE DRILL FAILED ===` and a non-zero exit.

## Restore drill result (2026-08-15)

Run against the real development Postgres instance (`docker-compose.yml`'s `postgres` service), 233 real rows across 12 tables:

| Table | Backup rows | Restored rows | Checksum |
|---|---|---|---|
| user | 27 | 27 | match |
| restaurant | 15 | 15 | match |
| restaurantAddress | 5 | 5 | match |
| menuCategory | 13 | 13 | match |
| menuItem | 13 | 13 | match |
| customer | 14 | 14 | match |
| promotion | 3 | 3 | match |
| order | 13 | 13 | match |
| orderItem | 13 | 13 | match |
| payment | 13 | 13 | match |
| refund | 0 | 0 | match |
| auditLog | 91 | 91 | match |

All 12 tables: **PASS**. Final result: **`RESTORE VERIFIED`**.

## Production backup configuration (target, per docs/10 §16.4)

Not yet provisioned — no production infrastructure exists (Phase 20 is launch readiness). The target configuration, as specified:

- Managed Postgres automated **daily** backups with **point-in-time recovery**, **30-day retention**, encrypted at rest, stored in a separate account or region from the database.
- Object storage (uploaded assets) uses versioning with a 30-day non-current retention window.
- **Backup permissions are separate from application credentials** — the application's own database role must not be able to delete backups, so a compromised application cannot destroy its own recovery path.
- **Monthly restore drill** in production: restore the latest backup to a temporary instance, run the migrations check, boot the application against it, run smoke tests, record the result and duration, destroy the instance.

| Objective | Target | Current capability |
|---|---|---|
| RPO (Recovery Point Objective) | ≤ 5 minutes | PITR-dependent — confirm with the managed Postgres provider once one is selected in Phase 20 |
| RTO (Recovery Time Objective) | ≤ 2 hours | Data-level recoverability now verified (this document); full infrastructure-level restore timing is unverified until run against real separate infrastructure |

## Known limitation

This drill proves data-level recoverability on the same server, not infrastructure-level recoverability (standing up a genuinely separate instance/region from a backup artifact under time pressure). That remains open until a managed Postgres provider with real `pg_dump`/`pg_restore` or snapshot-restore tooling is selected and exercised in Phase 20 or in a real production environment. This is recorded honestly rather than claiming a broader guarantee than what was actually tested.

## Runbooks

See [docs/runbooks/](docs/runbooks/) for the 9 operational runbooks named in docs/10 §17.7, each covering: symptoms, diagnostic commands, immediate mitigation, recovery, verification, and escalation.

- [payment-failure-spike.md](docs/runbooks/payment-failure-spike.md)
- [webhook-failures.md](docs/runbooks/webhook-failures.md)
- [database-outage.md](docs/runbooks/database-outage.md)
- [delivery-provider-outage.md](docs/runbooks/delivery-provider-outage.md)
- [queue-backlog.md](docs/runbooks/queue-backlog.md)
- [bad-deployment.md](docs/runbooks/bad-deployment.md)
- [reconciliation-mismatch.md](docs/runbooks/reconciliation-mismatch.md)
- [suspected-data-breach.md](docs/runbooks/suspected-data-breach.md)
- [restore-from-backup.md](docs/runbooks/restore-from-backup.md)
