# Launch Report — Phase 20

Date: 2026-08-15. Scope: docs/14-acceptance-criteria.md's Phase 20 criteria, evaluated against actual evidence, not intent.

## Status: **NOT READY**

Per docs/14's own Phase 20 checklist:

| Criterion | Status | Evidence |
|---|---|---|
| Production deployed with migrations applied and health checks green | **NOT MET** | No production environment exists — no cloud accounts, no domain, nothing deployed. |
| Smoke tests pass against production | **NOT MET** | A real, broader-than-health-check smoke suite exists and passes 10/10 against the local dev server (`pnpm smoke-test`) — it has never run against production, because production does not exist. |
| Monitoring and alerts verified as firing | **NOT MET** | The data every alert needs is real and queryable (`/admin/system-health`, Sentry once configured). The alert *rules and routing* (paging, uptime monitoring) are unconfigured — there is no monitoring platform deployed to configure them in. |
| All external dependencies reported with accurate status | **MET** | See below and [PRODUCTION_LAUNCH_CHECKLIST.md](PRODUCTION_LAUNCH_CHECKLIST.md). |
| `LAUNCH_REPORT.md` states a status justified by evidence, names every blocker | **MET** | This document. |

`NOT READY` is the honest status, not `READY WITH ACCEPTED RISKS` — that middle status implies a running production system with specific, named, accepted gaps. Nothing is running in production. The gap here is "no production exists yet," not "production exists with known limitations."

## What is genuinely done

All 20 phases of `docs/13-implementation-phases.md` are complete: full application (customer ordering, restaurant management, admin panel, payments, delivery, notifications, promotions, reviews, loyalty/referrals, support, analytics), a full security audit with every critical/high finding fixed (`SECURITY_AUDIT.md`), a verified backup/restore mechanism (`DISASTER_RECOVERY.md` — `RESTORE VERIFIED`), 9 operational runbooks plus a consolidated `OPERATIONS_RUNBOOK.md`, a real local load test (`LOAD_TEST_RESULTS.md`), and a real local smoke test (`scripts/smoke-test.mjs`, 10/10 passing). 510 automated tests passing, full typecheck/lint/build clean across every workspace. Every piece of this is real, tested code — not scaffolding, not stubs pretending to be finished.

## Why NOT READY, precisely

This is not a code-quality gap. It is the literal absence of infrastructure to deploy onto. See [PRODUCTION_LAUNCH_CHECKLIST.md](PRODUCTION_LAUNCH_CHECKLIST.md) for the complete, itemized list; the blockers that matter most:

1. **No cloud accounts, no domain, no DNS, no TLS.** Nothing to deploy to, no address for it to be reachable at.
2. **No managed Postgres/Redis provisioned.** The schema, migrations, and every query are provider-agnostic and ready — there is no server to point them at.
3. **No real payment provider credentials.** Razorpay live account + KYC is unresolved (docs/10 §17.8); `PAYMENT_PROVIDER=mock` is correctly wired and has been honestly used as `mock` in every phase's live verification, never overstated as real.
4. **No real delivery/SMS/WhatsApp provider credentials.** Same pattern — `DELIVERY_PROVIDER=mock`/`SMS_PROVIDER=console` are genuine, tested integrations waiting on real credentials, not gaps in the code.
5. **Payment settlement / legal structure unresolved** (docs/15-ambiguities-and-risks.md AMB-3) — a business and legal decision, out of engineering's ability to resolve.
6. **No monitoring/alerting platform deployed** — the data exists; the routing does not, because there is nowhere to route it to yet.

None of these are closed by writing more code. Every one requires the platform owner's decision, an account, a credential, or a purchase.

## What changes this to READY

In order, per [PRODUCTION_LAUNCH_CHECKLIST.md](PRODUCTION_LAUNCH_CHECKLIST.md):

1. Provision cloud accounts, managed Postgres, managed Redis, object storage, domain + DNS + TLS.
2. Populate real secrets in the hosting platform's secret store (`.env.example` names every one).
3. Run the real deploy sequence (docs/10 §17.3 / `OPERATIONS_RUNBOOK.md`): backup → migrate → backend → worker → frontend → **`pnpm smoke-test` against the real production URL** → 30-minute watch.
4. Configure real alert routing against the threshold table in docs/10 §17.6 / `OPERATIONS_RUNBOOK.md`.
5. Re-verify graceful shutdown under a genuine OS-delivered SIGTERM on the real (Linux) production host — unverifiable on this sandbox's native Windows environment (see `LOAD_TEST_RESULTS.md`).
6. Re-run the restore drill at the infrastructure level once a managed Postgres provider with real `pg_dump`/`pg_restore` or snapshot-restore tooling is selected (the current `RESTORE VERIFIED` is data-level, same-server — see `DISASTER_RECOVERY.md`'s own honest limitation section).
7. Separately, and not blocking a soft/limited launch on mock providers: real Razorpay/Uber Direct/MSG91/WhatsApp credentials, whenever the business is ready to move off `mock`/`console`.

Once steps 1–6 are done and a real deploy passes its own smoke test and 30-minute watch, this status should be re-evaluated — likely landing on `READY WITH ACCEPTED RISKS` at that point (given step 7 can reasonably remain mock/console for a soft launch, per the pilot's own documented scope), not before.
