# Production Launch Checklist — Phase 20

Date: 2026-08-15. Status of every item below is one of `DONE`, `BUILT — NOT YET RUN AGAINST PRODUCTION`, or `REQUIRES EXTERNAL ACTION` (docs/10-infrastructure-deployment.md §17.8's own status-honesty framework, extended with the middle category for work that's real and tested but has never touched real production infrastructure because none exists). See [LAUNCH_REPORT.md](LAUNCH_REPORT.md) for the overall go/no-go call this checklist feeds.

## 1. Infrastructure provisioning

- [ ] **Cloud accounts** (hosting for `apps/api`/`apps/worker`, Vercel or equivalent for `apps/web`) — **REQUIRES EXTERNAL ACTION**. Nothing to provision from inside this codebase; docs/10 §16.6 gives the target cost profile (~$50–120/month at pilot scale).
- [ ] **Managed Postgres** (with automated daily backups + PITR, per docs/10 §16.4) — **REQUIRES EXTERNAL ACTION**. `prisma/schema.prisma` and every migration are provider-agnostic; no provider-specific code exists to write.
- [ ] **Managed Redis** — **REQUIRES EXTERNAL ACTION**.
- [ ] **Object storage + CDN** (uploads, per docs/06 upload flow) — **REQUIRES EXTERNAL ACTION**.
- [ ] **Domain + DNS** — **REQUIRES EXTERNAL ACTION**. Blocks TLS, blocks a real `API_BASE_URL`/`WEB_BASE_URL`, blocks launch outright (docs/10 §17.8).
- [ ] **TLS** — **REQUIRES EXTERNAL ACTION**, follows from domain provisioning; most managed hosts issue this automatically once DNS is pointed at them.

## 2. Secrets and configuration

- [ ] Every required env var is named, typed, and validated at startup — **DONE**. `apps/api/src/platform/config/env.schema.ts` and `apps/worker/src/env.schema.ts` fail fast with the specific missing variable named, never a silent default for anything security- or money-relevant.
- [ ] Production rejects dev/localhost origins — **DONE, tested** (Phase 18: `isDevOrigin` startup assertion; `apps/api/test/env.schema.test.ts`).
- [ ] `.env.example` carries names/formats only, never real values — **DONE** (Phase 16 acceptance criteria, unchanged since).
- [ ] Real secret values (`DATABASE_URL`, `REDIS_URL`, `RAZORPAY_*`, `SESSION_SECRET`, `CSRF_SECRET`, provider API keys) populated in the real hosting platform's secret store — **REQUIRES EXTERNAL ACTION**.
- [ ] `SENTRY_DSN`/`SENTRY_ENVIRONMENT` set — **REQUIRES EXTERNAL ACTION** (Phase 19 wiring is a genuine no-op without it; see §4 below).
- [ ] Backup permissions separate from application credentials (docs/10 §16.4: "a compromised application must not be able to delete its own backups") — **REQUIRES EXTERNAL ACTION**, a provider-side IAM/role configuration, not application code.

## 3. External provider activation (blocks real transactions, not launch of the platform itself)

- [ ] Razorpay live account + KYC — **REQUIRES EXTERNAL ACTION**. Blocks real payments. `PAYMENT_PROVIDER=mock` ships correctly without it (every phase's live verification used the mock provider honestly, never claiming real-provider verification it didn't have).
- [ ] Payment settlement / legal structure (docs/15-ambiguities-and-risks.md, AMB-3) — **REQUIRES EXTERNAL ACTION**. A business/legal decision, not a code gap.
- [ ] Uber Direct API approval — **REQUIRES EXTERNAL ACTION**. Blocks automated delivery dispatch; `DELIVERY_PROVIDER=mock` ships without it.
- [ ] MSG91 account + DLT template registration — **REQUIRES EXTERNAL ACTION**. Blocks SMS; `SMS_PROVIDER=console` ships without it.
- [ ] WhatsApp Business API approval — **REQUIRES EXTERNAL ACTION**. Blocks WhatsApp; SMS is the documented fallback.

## 4. Monitoring, alerting, and dashboards

- [ ] Sentry error tracking wired in both apps — **DONE, tested as a no-op without a DSN** (Phase 19: `apps/api/src/platform/observability/sentry.ts`, `apps/worker/src/sentry.ts`, `apps/api/test/sentry.test.ts`). Becomes live the moment `SENTRY_DSN` is set — no code change needed.
- [ ] `GET /admin/system-health` — **DONE, live-verified against real Postgres/Redis** (Phase 19) — outbox/notification backlog, oldest-pending age, dead-letter count, open reconciliation issues by severity, evaluated against docs/10 §17.6's threshold table.
- [ ] `GET /health` / `GET /ready` — **DONE, live-verified**, and CI-verified against real Postgres on every change (`.github/workflows/ci.yml`'s `live-database-smoke-test` job).
- [ ] The alert table in docs/10 §17.6 (API 5xx rate, `/ready` failing, payment success rate, webhook signature failures, reconciliation issues, delivery dispatch failures, DLQ non-empty, queue oldest-job age, DB connection pool, notification failure rate, backup job failed) wired into a real alerting/paging system (Sentry alerts, an uptime monitor, PagerDuty/Opsgenie or equivalent) — **REQUIRES EXTERNAL ACTION**. The data every one of these alerts needs already exists and is queryable (`/admin/system-health`, Sentry once configured, provider dashboards); wiring the actual alert *rules and routing* is a dashboard/monitoring-platform configuration step with no corresponding application code to write.
- [ ] A real uptime/synthetic monitor hitting `/health` and `/ready` from outside the hosting network — **REQUIRES EXTERNAL ACTION**.

## 5. Regression, smoke tests, and load

- [ ] Full regression suite passes — **DONE**. 510/510 tests, `pnpm run typecheck`/`lint`/`build`/`test` all clean (Phase 19's final sweep; re-confirmed for Phase 20's own additions, see LAUNCH_REPORT.md).
- [ ] A real smoke-test suite exists, is broader than a bare health check, and has been run successfully against a live server — **DONE locally, not yet against production** (`pnpm smoke-test`, Phase 20 — `scripts/smoke-test.mjs`: liveness/readiness, public restaurant browse, security headers, a full admin login + MFA + authorized-read cycle. 10/10 passed against the local dev server). Must be re-run against the real production URL immediately after the first real deploy (docs/10 §17.3, deploy sequence step 6) before traffic is considered launched.
- [ ] A real load test has been run — **DONE locally (autocannon), not staging/k6** (Phase 19, `LOAD_TEST_RESULTS.md`) — zero errors/timeouts/non-2xx against the real dev server. docs/11 names k6 against staging specifically; re-run there once a staging environment exists.

## 6. Backup, disaster recovery, and operational runbooks

- [ ] A real, verified restore drill has passed — **DONE** (Phase 19, `DISASTER_RECOVERY.md`: `=== RESTORE VERIFIED ===` against 233 real rows across 12 tables). Data-level, not infrastructure-level (see that document's own honest limitation section) — re-verify at the infrastructure level once a managed Postgres provider with real `pg_dump`/`pg_restore` or snapshot-restore is selected.
- [ ] Production backup configuration (daily automated backups, PITR, 30-day retention, encrypted, separate account/region, backup-permission isolation) — **REQUIRES EXTERNAL ACTION**, provider configuration.
- [ ] 9 named operational runbooks written and grounded in this codebase's real endpoints — **DONE** (Phase 19, `docs/runbooks/`).
- [ ] `OPERATIONS_RUNBOOK.md` consolidating deploy/rollback/monitoring/escalation into one entry point — **DONE** (Phase 20, this checklist's sibling document).

## 7. Deploy mechanics

- [ ] CI pipeline (install → typecheck → lint → format → unit/integration tests → Testcontainers Postgres → build both apps → `npm audit` → gitleaks) — **DONE**, `.github/workflows/ci.yml`, has run on every phase since it was introduced.
- [ ] Documented deploy sequence (backup → migrate → backend rolling deploy gated on `/ready` → workers → frontend → smoke tests → 30-minute watch) — **DONE**, docs/10 §17.3, unchanged and still accurate.
- [ ] Documented rollback procedure per component, with named triggers — **DONE**, docs/10 §17.4, and `docs/runbooks/bad-deployment.md` (Phase 19) operationalizes it.
- [ ] Graceful shutdown on SIGTERM — **DONE, mechanism verified** (real `app.close()` test); **NOT verified at the OS-signal level** on this native-Windows sandbox (Phase 19, `LOAD_TEST_RESULTS.md`) — first real Linux deploy is the natural place to confirm the live signal path.
- [ ] An actual first production deploy, migrations applied, health checks green against real infrastructure — **REQUIRES EXTERNAL ACTION** (blocked on §1's provisioning).

## 8. Security

- [ ] Full security audit against docs/09, all critical/high findings fixed — **DONE** (Phase 18, `SECURITY_AUDIT.md`).
- [ ] Dependabot configured — **DONE** (`.github/dependabot.yml`).
- [ ] Build-time secret-leak scan on the web bundle — **DONE**, wired as `apps/web`'s `postbuild` step.
- [ ] A real penetration test against deployed production infrastructure — **REQUIRES EXTERNAL ACTION** (no deployed environment exists yet to test; `SECURITY_AUDIT.md` names this explicitly as its own boundary).

---

Every unchecked `REQUIRES EXTERNAL ACTION` item above requires the platform owner's decision, an account, a credential, or a purchase — none can be completed by writing more code. Every other item is either done or built-and-locally-verified, ready to run again the moment real infrastructure exists.
