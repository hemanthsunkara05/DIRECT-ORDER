# Load Test Results — Phase 19

Date: 2026-08-15. Scope: docs/13-implementation-phases.md Phase 19's "Load testing on staging" item, and docs/17-graceful-shutdown verification.

## Honesty note

docs/11-testing-strategy.md §18.2 names **k6** as the load-testing tool, explicitly scoped to **staging only**. No staging environment exists yet — no cloud accounts, no domain, nothing deployed (Phase 20 is launch readiness; see docs/10 §17.8's external-dependency table). k6 is also a standalone Go binary, not an npm package, and this sandbox has no mechanism to install standalone binaries (the same constraint already documented in [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) for `pg_dump`/`pg_restore`).

What follows is a **real load test run locally**, against the real dev API server (`apps/api`, Fastify/NestJS) backed by the real local Postgres and Redis instances this project uses in development — using **autocannon** (a real HTTP load generator, not a mock) instead of k6. This is honestly weaker evidence than a staging run: single machine, no network hop, no horizontal scaling, no realistic concurrent-tenant traffic mix. It is reported as a local result, not represented as the docs/11 k6/staging benchmark.

## How to run it

```bash
pnpm --filter=./apps/api run dev   # start the API on :4000
pnpm load-test                     # in a second terminal
```

Configurable via env vars: `LOAD_TEST_BASE_URL` (default `http://localhost:4000`), `LOAD_TEST_DURATION` (seconds, default 15), `LOAD_TEST_CONNECTIONS` (default 20).

## Results (2026-08-15, local dev server, 20 connections, 15s per scenario)

| Scenario | req/s (avg) | latency mean | latency p99 | errors | timeouts | non-2xx |
|---|---|---|---|---|---|---|
| `GET /public/restaurants/:slug` | 78.87 | 251.46ms | 355ms | 0 | 0 | 0 |
| `GET /public/restaurants/:slug/menu` | 188.74 | 105.44ms | 176ms | 0 | 0 | 0 |
| `GET /health` | 1140.94 | 17.01ms | 55ms | 0 | 0 | 0 |

**Zero errors, zero timeouts, zero non-2xx responses across all three scenarios.** All requests hit real Postgres (no caching layer in front of these reads yet).

## Observation: restaurant-profile vs. menu latency gap

The profile endpoint (`:slug`) is measurably slower than the menu endpoint (`:slug/menu`) — 251ms vs. 105ms mean. Traced to `PublicRestaurantService.getProfile` (`apps/api/src/modules/public/services/public-restaurant.service.ts`) doing more sequential round-trips than `getMenu`: a restaurant lookup, then an active-closure check, then (inside `AvailabilityService.isAcceptingOrders`) a scheduled-hours check that itself queries both today's and yesterday's shifts. `getMenu` does one lookup followed by two queries in parallel.

This is **proportional, expected work** (real availability logic — closures, special-hours overrides, day-boundary-spanning shifts — not an N+1 loop or a missing index), not a defect. At pilot scale (single-digit restaurants, a few hundred req/day) 251ms mean / 355ms p99 is well within acceptable UX bounds, so no change was made under time pressure to avoid adding complexity the current scale doesn't need. Recorded here as a measured data point for future capacity planning, per docs/13's "query optimisation driven by measurement" — the measurement happened; no optimization was warranted yet.

## Graceful shutdown — SIGTERM verification

The mechanism is verified two ways:

1. **Automated, in-process** (`apps/api/test/graceful-shutdown.test.ts`) — confirms all 6 self-starting schedulers (`OutboxService`, `OrderExpiryScheduler`, `NotificationRetryScheduler`, `LoyaltyReconciliationService`, `AnalyticsRollupService`, `DataIntegrityService`) clear their timers on `onModuleDestroy()`, and that a real Nest `app.close()` with every scheduler active resolves within 5 seconds without hanging. This passes.

2. **Real OS-level signal, attempted live**: with the dev server running (PID confirmed via `Get-NetTCPConnection -LocalPort 4000`), ran `node -e "process.kill(<pid>, 'SIGTERM')"` against the live process. **Result: the process terminated immediately with zero graceful-shutdown log output** — none of `registerGracefulShutdown`'s (`apps/api/src/main.ts`) expected log lines (drain start, jobs finishing, pools closing) appeared before the process exited.

   **Root cause, not a code bug**: this sandbox is native Windows, which has no POSIX signal delivery. Node.js's own documented behavior is that `process.kill(pid, 'SIGTERM')` on Windows unconditionally force-terminates the target process (equivalent to `SIGKILL`) rather than invoking any `process.on('SIGTERM', ...)` handler — `registerGracefulShutdown`'s handler is real and correctly registered (confirmed by reading `main.ts`; it listens for both `'SIGTERM'` and `'SIGINT'`), but there is no way to deliver a genuinely catchable SIGTERM to a Windows process from this sandbox to exercise it end-to-end. The production target is Linux containers (docs/10's deployment model), where the orchestrator sends a real POSIX SIGTERM and this exact code path runs as written — that remains unverified in a live, OS-signal sense until this runs in a real Linux environment (Phase 20 or later), and is recorded honestly as such rather than claiming a live verification that didn't actually happen.

**Conclusion**: graceful shutdown *mechanism* is verified (automated test, passing). Graceful shutdown under a *genuine OS-delivered SIGTERM* is not verifiable in this native-Windows sandbox and remains an open item for the first real Linux deployment.
