# Operations Runbook — Phase 20

The single entry point for running this system day-to-day. Links out to the detailed documents rather than duplicating them — if something here and the linked document disagree, the linked document is authoritative.

## Health and readiness

| Endpoint | Meaning | Governs |
|---|---|---|
| `GET /health` | Liveness — process responsive, no dependency checks. | Restart-loop protection: a database blip must never restart a healthy process. |
| `GET /ready` | Readiness — database reachable, Redis reachable, migrations applied. | Traffic routing — a load balancer/orchestrator drains an instance that fails this. |
| `GET /admin/system-health` | Outbox/notification backlog depth, oldest-pending age, dead-letter count, open reconciliation issues by severity. Gated on `payments:reconcile`. | Day-to-day operational monitoring — this is the first thing to check when something feels backed up. |

## Deploy

Order matters (docs/10-infrastructure-deployment.md §17.3 — full detail there):

1. Back up the database (snapshot, record the identifier).
2. Run migrations — expand-only, backward compatible with the currently-running version.
3. Deploy the backend, rolling, gated on `/ready`.
4. Deploy the worker(s).
5. Deploy the frontend.
6. Run the smoke test suite: `SMOKE_TEST_BASE_URL=<production URL> pnpm smoke-test` (Phase 20, `scripts/smoke-test.mjs`) — liveness/readiness, public browsing, security headers, a full admin login+MFA+authorized-read cycle. Do not consider the deploy complete until this passes against the real production URL.
7. Watch error rate and payment success rate for 30 minutes.

## Rollback

Full detail and named triggers: docs/10 §17.4, operationalized in [docs/runbooks/bad-deployment.md](docs/runbooks/bad-deployment.md). Summary:

| Component | Procedure |
|---|---|
| Frontend | Instant revert to the previous deployment. |
| Backend/worker | Redeploy the previous image tag. |
| Configuration | Restore previous values, restart. |
| Database | Do not blindly reverse a migration — expand-only migrations mean an application rollback alone is usually sufficient. Genuine corruption uses PITR to a pre-incident timestamp, a deliberate approved decision (see [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)). |

Rollback triggers: error rate > 5% for 5 minutes, payment success < 90%, authentication broken, any tenant-isolation failure, database corruption.

## Monitoring and alerts

The full threshold table is docs/10 §17.6. Every alert in that table names the runbook that responds to it:

| Alert | Runbook |
|---|---|
| Payment success rate < 90% | [payment-failure-spike.md](docs/runbooks/payment-failure-spike.md) |
| Webhook signature failures > 5/10min | [webhook-failures.md](docs/runbooks/webhook-failures.md) |
| `/ready` failing | [database-outage.md](docs/runbooks/database-outage.md) |
| Delivery dispatch failures > 20%/30min | [delivery-provider-outage.md](docs/runbooks/delivery-provider-outage.md) |
| Any DLQ non-empty; queue oldest job age > 10min | [queue-backlog.md](docs/runbooks/queue-backlog.md) |
| API 5xx rate > 2%/5min; any rollback trigger | [bad-deployment.md](docs/runbooks/bad-deployment.md) |
| Reconciliation issue created (any CRITICAL) | [reconciliation-mismatch.md](docs/runbooks/reconciliation-mismatch.md) |
| Suspected credential compromise / cross-tenant exposure | [suspected-data-breach.md](docs/runbooks/suspected-data-breach.md) |
| Backup job failed; a restore is actually needed | [restore-from-backup.md](docs/runbooks/restore-from-backup.md) |

**An alert without a documented response is noise and should be deleted or fixed** — every alert in the table above already has one.

Wiring the alert *rules and routing* themselves (Sentry alert rules, an uptime monitor, a paging system) is external-platform configuration, not application code — see [PRODUCTION_LAUNCH_CHECKLIST.md](PRODUCTION_LAUNCH_CHECKLIST.md) §4. The data every rule needs already exists and is queryable today via the endpoints in the table above and Sentry (once `SENTRY_DSN` is set — the wiring is already a real, tested no-op-without-it integration).

## Escalation

1. Identify the relevant runbook from the table above and follow it.
2. If genuinely uncertain which runbook applies, or if a `CRITICAL` reconciliation issue or tenant-isolation failure is involved, treat it as the highest-severity case regardless of how it was first reported.
3. Anything involving real money (a `payments`-severity or reconciliation-`CRITICAL` finding) or a confirmed data breach gets escalated immediately, not queued behind lower-severity work.

## Backup and restore

See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) for the full mechanism, current verified status (`RESTORE VERIFIED` as of 2026-08-15), and RPO/RTO targets. Quick reference:

```bash
# Dev/local drill (same-server schema swap — see DISASTER_RECOVERY.md for why):
DATABASE_URL="<DATABASE_URL>&schema=restore_drill" npx prisma migrate deploy --schema prisma/schema.prisma
pnpm db:restore-drill
```

A genuine production restore uses the managed Postgres provider's own `pg_dump`/`pg_restore` or PITR/snapshot tooling — see [docs/runbooks/restore-from-backup.md](docs/runbooks/restore-from-backup.md).

## Local development reference

```bash
pnpm install
cp .env.example .env
docker compose up -d      # postgres + redis + minio
pnpm db:migrate
pnpm db:seed               # demo restaurant, menu, users — dev/pilot only, never run against production
pnpm dev                   # api :4000, web :3000, worker
pnpm smoke-test             # broader than a bare health check — see above
pnpm load-test               # local, not staging — see LOAD_TEST_RESULTS.md
```
