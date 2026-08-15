# Runbook: Bad deployment

Rollback triggers (docs/10 §17.4): error rate above 5% for 5 minutes, payment success below 90%, authentication broken, any tenant-isolation failure, database corruption.

## Symptoms

- API 5xx rate alert (> 2% for 5 min), or one of the harder rollback triggers above.
- Smoke tests fail post-deploy (docs/10 §17.3's deploy sequence runs these — a bad deploy should ideally never reach "watch for 30 minutes" in the first place).
- A specific feature/endpoint broken that correlates with the most recent deploy's changeset.

## Diagnostic commands

1. Confirm the timing correlation: did the error rate/symptom start at or shortly after the last deploy's timestamp?
2. Check which layer changed — frontend only, backend/worker, database migration, or configuration — since the rollback procedure differs per docs/10 §17.4's table.
3. If a migration ran: confirm whether it was expand-only (the required style per docs/10 §17.3) — an expand-only migration means an application-level rollback alone is sufficient and safe; a migration that dropped/renamed something is a materially harder case.

## Immediate mitigation (docs/10 §17.4)

| Component | Procedure |
|---|---|
| Frontend | Instant revert to the previous deployment. |
| Backend/worker | Redeploy the previous image tag. |
| Configuration | Restore previous values, restart. |
| Database | **Do not blindly reverse a migration.** Expand-only migrations are backward compatible, so an application rollback alone is usually sufficient. Genuine data corruption uses PITR to a pre-incident timestamp — a deliberate, approved decision, not a reflexive one. |

- Roll back the layer that actually changed — do not roll back frontend and backend together by default if only one moved; unnecessary rollbacks add risk and confusion.
- If tenant isolation is the trigger: treat this as the highest-severity case regardless of error-rate numbers — a cross-tenant data leak does not need to hit a percentage threshold to warrant an immediate rollback.

## Recovery

- After rollback, re-run smoke tests against the now-reverted environment before declaring the incident over.
- Do not re-attempt the same deploy without first reproducing and fixing the root cause locally/in CI — docs/10 §17.2's CI pipeline (typecheck, lint, tests, build, audit, secret scan) should have caught most classes of bad deploy; if it didn't, the gap in CI coverage is itself worth fixing before the next attempt.

## Verification

- Error rate back under 2% sustained, payment success back above 90%, `/ready` healthy across instances.
- No new tenant-isolation or reconciliation issues since the rollback.

## Escalation

- Any deploy that reached production and caused financial-data inconsistency (not just an outage): escalate as a data-integrity incident — run `DataIntegrityService.runAll()` manually rather than waiting for the scheduled run, and review `GET /admin/reconciliation-issues` for anything newly opened in the bad-deploy window.
- If the root cause is unclear after rollback: keep the previous (bad) image/build artifact available for offline investigation rather than discarding it immediately.
