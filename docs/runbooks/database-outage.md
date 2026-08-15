# Runbook: Database outage

Alert: **`/ready` failing, any instance, 2 min** — CRITICAL (docs/10 §17.6). Documented behavior (docs/10 §16.5): *"Postgres down → API returns 503 on `/ready`, traffic drains. No degraded write path — inconsistent financial state is worse than downtime."*

## Symptoms

- `/ready` returns non-200; `/health` (liveness only) may still return 200, since it does not check dependencies — this is expected and correct, not a bug, if only the database is affected.
- Load balancer/orchestrator drains traffic from affected instances as `/ready` fails.
- API requests that reach an instance before drain completes fail with connection-pool/timeout errors.

## Diagnostic commands

1. Confirm the database is actually down/unreachable vs. the application's connection pool being exhausted (`Database connections > 80% of pool` is a separate, lower-severity MEDIUM alert — check it first, since pool exhaustion looks similar but has a different fix).
2. Check the managed Postgres provider's own status page/dashboard for a confirmed outage vs. a network-path issue between the API and the database.
3. Check recent migrations/deploys — a migration that locks a hot table for longer than expected can look like an outage from the application's side.

## Immediate mitigation

- **This system intentionally has no degraded write path for a database outage** — do not attempt to add one under incident pressure (e.g., queuing writes in memory, accepting orders without persisting them). docs/16.5 is explicit that inconsistent financial state is worse than downtime; the correct behavior during a real outage is exactly what already happens: `/ready` fails, traffic drains, the system waits.
- If the outage is provider-side: there is nothing to do on the application side except wait and communicate status; do not restart application instances repeatedly, since that will not fix a database-side outage and adds noise.
- If it's a connection-pool exhaustion (not a true outage): check for a recent change that increased per-request connection usage or a long-running query holding connections; killing the offending query/session is safer than restarting the whole pool blind.

## Recovery

- Once the database is confirmed reachable again, `/ready` should self-recover (it re-checks on every call — there is no manual "un-drain" step).
- If the outage was caused by the primary going down and a failover/replica promotion occurred, confirm the application's `DATABASE_URL` still points at a writable primary (managed providers typically handle this transparently, but confirm rather than assume).

## Verification

- `/ready` returns 200 across all instances.
- `GET /admin/system-health` shows outbox/notification backlog draining, not growing (jobs paused during the outage should resume and catch up — docs/16.5's Redis-down row describes the same "pause and catch up" pattern, and the database case is analogous once connectivity returns).
- Spot-check that no orders were left in an inconsistent state — run the data-integrity assertion suite (`DataIntegrityService.runAll()`) rather than waiting for its next scheduled run.

## Escalation

- Outage lasting more than the provider's stated SLA, or ambiguous root cause: escalate to the managed Postgres provider's support with the exact outage window.
- If a failover promoted a replica that is behind the primary (possible data loss for the gap): treat as a data-loss incident — consult [restore-from-backup.md](restore-from-backup.md) and this repo's [DISASTER_RECOVERY.md](../../DISASTER_RECOVERY.md) for the RPO this system currently targets (≤ 5 minutes, PITR-dependent) before deciding whether a point-in-time restore is warranted.
