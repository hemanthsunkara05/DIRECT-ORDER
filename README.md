# Direct-Order

Commission-free direct-ordering platform for independent Indian restaurants. Each restaurant gets a branded ordering link, a real-time order dashboard, online payments, and transparent visibility into every rupee — without giving up 25–35% of order value to an aggregator.

**Status:** Phase 4 (Authorization) — see [PRODUCT/docs/13-implementation-phases.md](PRODUCT/docs/13-implementation-phases.md). Foundation (Phase 1), core schema and tenancy (Phase 2), authentication (Phase 3), and the permission catalogue + tenant-isolation guards (Phase 4) are done. No real restaurant-scoped business endpoint exists yet — Phase 4 built and proved the enforcement machinery every domain module from Phase 5 onward will attach to its own routes.

Full specification: [PRODUCT/IMPLEMENTATION_HANDOFF.md](PRODUCT/IMPLEMENTATION_HANDOFF.md).

---

## Stack

TypeScript everywhere. Next.js 15 (frontend) · NestJS on Fastify (API) · PostgreSQL 16 + Prisma · Redis (rate limiting since Phase 3; job queues via BullMQ from Phase 12) · pnpm workspaces monorepo.

See [PRODUCT/IMPLEMENTATION_HANDOFF.md §4](PRODUCT/IMPLEMENTATION_HANDOFF.md#4-technology-stack) for the full stack with rationale.

## Repository layout

```
apps/
  api/       NestJS backend — REST API, webhooks (from Phase 9)
  web/       Next.js frontend — public ordering site, dashboard, admin
  worker/    Background job processor (BullMQ consumers, from Phase 12)
packages/
  contracts/ Shared Zod schemas + inferred types (API request/response shapes)
  money/     BigInt minor-unit money arithmetic — the only place money math happens
  config/    Shared ESLint/TypeScript/Prettier configuration
prisma/      Database schema and migrations (single schema, shared by api + worker)
docs/        Phase reports, runbooks (added as later phases produce them)
```

See [PRODUCT/docs/12-repository-structure.md](PRODUCT/docs/12-repository-structure.md) for conventions.

## Prerequisites

- Node.js 22+
- pnpm 9+ (`npm install -g pnpm`)
- Docker (for local Postgres, Redis, MinIO via `docker-compose.yml`)

## Getting started

```bash
git clone <repo-url>
cd PRODUCT
pnpm install

cp .env.example .env
# Edit .env if you need non-default values. The defaults match
# docker-compose.yml, so a fresh clone works with zero edits.

docker compose up -d
# Starts Postgres (5432), Redis (6379), MinIO (9000/9001).
# Wait ~10s for health checks to pass, or run: docker compose ps

pnpm db:generate   # Generates the Prisma client
pnpm db:migrate    # Creates and applies migrations
pnpm db:grants     # Applies restricted runtime-role privileges (prisma/grants.sql)
pnpm db:seed       # Optional: two sample restaurants with distinct owners/staff

pnpm dev
# Starts api (http://localhost:4000), web (http://localhost:3000),
# and worker in parallel, with file watching.
```

Verify the stack is up:

```bash
curl http://localhost:4000/health   # {"status":"ok"}
curl http://localhost:4000/ready    # {"status":"ready","checks":{"database":{"status":"ok",...}}}
open http://localhost:3000          # "Direct-Order" placeholder page
open http://localhost:3000/signup   # Create a restaurant-owner account (Phase 3)
```

## Common commands

Run from the repository root unless noted.

| Command                  | What it does                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `pnpm dev`               | Start api + web + worker in parallel, watching for changes           |
| `pnpm build`             | Build every app and package for production                           |
| `pnpm test`              | Run every workspace's test suite (Vitest)                            |
| `pnpm test:e2e`          | Run Playwright end-to-end tests against apps/web                     |
| `pnpm typecheck`         | Type-check every workspace (`tsc --noEmit`)                          |
| `pnpm lint`              | Lint the whole repo (fails on any warning)                           |
| `pnpm lint:fix`          | Lint and auto-fix what's fixable                                     |
| `pnpm format`            | Format the whole repo with Prettier                                  |
| `pnpm format:check`      | Check formatting without writing (used in CI)                        |
| `pnpm db:generate`       | Regenerate the Prisma client after a schema change                   |
| `pnpm db:migrate`        | Create + apply a new migration (local development)                   |
| `pnpm db:migrate:deploy` | Apply existing migrations without creating a new one (CI/production) |
| `pnpm db:grants`         | Apply `prisma/grants.sql` (restricted runtime-role privileges)       |
| `pnpm db:seed`           | Run `prisma/seed.ts`                                                 |

Scope a command to one workspace with `--filter`, e.g.:

```bash
pnpm --filter=@direct-order/api run test
pnpm --filter=@direct-order/money run test
```

## Environment variables

See [.env.example](.env.example) for the complete list, grouped by concern, each annotated with the phase that introduces the code reading it. Only the variables tagged `[PHASE 1]`, `[PHASE 1/2]`, or `[PHASE 3]` are read by anything that exists today; the rest are documented ahead of time so the full production configuration surface is visible from day one.

**Never commit `.env` or any file containing real secrets.** `.env.example` contains variable names and formats only.

In production (`APP_ENV=production`), the API refuses to start if `APP_DATABASE_URL`, `API_BASE_URL`, or `WEB_BASE_URL` are missing — it names the exact variable rather than failing later with an obscure error. `DATABASE_URL` (a separate variable) is used only by the Prisma CLI for migrations and grants, never by the running application — see Database roles below.

## Database roles

Two separate Postgres roles, deliberately (Phase 2, `docs/02-database-schema.md`):

- **`direct_order`** (`DATABASE_URL`) — the owner/migration role. Used only by `prisma migrate` and `pnpm db:grants`. Has full DDL privileges.
- **`direct_order_app`** (`APP_DATABASE_URL`) — the restricted runtime role the API and worker actually connect as. Created locally by `infrastructure/postgres/init/01-create-app-role.sql` on first `docker compose up`; its table-level privileges come from `prisma/grants.sql`, applied via `pnpm db:grants` after every migration.

The point: even if application code were compromised or buggy, it cannot rewrite `audit_logs` — `direct_order_app` is granted `SELECT, INSERT` on that table only, never `UPDATE`/`DELETE`, enforced by Postgres itself rather than trusted to application code alone.

Production provisions its own equivalent roles through the platform's secret manager, not these files.

## Authentication

Registration, login, logout, refresh, password reset, and email/phone verification (Phase 3, `docs/09-security.md` §15.2). A few load-bearing decisions worth knowing before touching this code:

- **Sessions, not just tokens.** Access tokens are short-lived JWTs (15 min) carrying `{sub, sid}`, but `AuthGuard` re-checks both the user's status and the referenced `Session` row's live/revoked status on every request — logout, password reset, and refresh-token-reuse detection all take effect immediately, not after the token happens to expire.
- **Refresh-token rotation with reuse detection.** Every `/auth/refresh` call issues a new refresh token and revokes the old one. Presenting an already-rotated token revokes the entire session family and logs a `SESSION_REUSE_DETECTED` audit event — see `SessionService.rotate()`.
- **Enumeration resistance.** `/auth/register`, `/auth/login`, and `/auth/password/forgot` return identical responses (and, for login, comparable timing via a dummy password-hash comparison) regardless of whether the account exists.
- **Rate limiting fails open.** `RateLimitGuard` allows a request through — logging a warning — if Redis is unreachable, rather than taking down the entire authentication surface over a rate-limiter dependency outage. It is defense-in-depth, not the primary control.
- Cookies (`do_access_token`, `do_refresh_token`) are `HttpOnly; SameSite=Lax; Path=/`, and `Secure` outside `APP_ENV=local` (a plain-HTTP `Secure` cookie would never reach the API in local development).

## Authorization

Permission catalogue, role definitions, and the tenant-isolation guards (Phase 4, `docs/05-authorization-matrix.md`). Answers the three questions every request must pass: authentication (Phase 3's `AuthGuard`), role capability (`@Permissions(...)`), and resource scope (`@TenantScoped()`).

- **Two decorators, one guard.** A tenant-scoped, permission-gated route declares `@TenantScoped()` and `@Permissions('menu:write')`; `AuthorizationGuard` (`platform/authorization`) reads both. It is **not** a global guard — Nest runs global guards before controller-level ones, and it depends on `AuthGuard` having already populated `request.user`, so every tenant-scoped controller applies both explicitly and in order: `@UseGuards(AuthGuard, AuthorizationGuard)`.
- **403 vs 404, deliberately different layers.** Sending `X-Restaurant-Id` for a restaurant the caller has no active membership in is **403** (`AuthorizationGuard`, logged as a `TENANT_ISOLATION_VIOLATION` audit event). Successfully resolving a tenant and then requesting a specific _resource_ that belongs to a different restaurant is **404**, not 403 — returning 403 would confirm the resource exists, leaking tenant structure (`docs/04-api-specification.md` §8.1). Domain modules get this for free by passing a tenant-scoped repository lookup's `null` result through `assertTenantResourceFound()`.
- **Membership is re-checked per request**, exactly like Phase 3's session liveness check — a staff member disabled mid-session loses access on their very next request, not when their token happens to expire.
- **Only restaurant roles (STAFF/MANAGER/OWNER) are enforceable today.** The permission catalogue also encodes SUPPORT/OPS/FINANCE/SUPER_ADMIN per the documented matrix, but `admin_users` (Phase 13) doesn't exist yet, so no principal can actually hold those roles — a route requiring only an admin-capable permission always denies.
- No real business endpoint uses these guards yet — see `apps/api/test/authorization.e2e.test.ts` for the test-only probe controller that proves the full pipeline over real HTTP ahead of Phase 5 attaching it to real routes.

## Testing

- **Unit / integration:** Vitest, per workspace (`apps/api/test`, `packages/money/test`, ...). API integration tests boot a real NestJS + Fastify application over real HTTP (via supertest); `PrismaService` and `RedisService` are overridden with in-memory stand-ins (`apps/api/test/support/`) rather than requiring a live database and Redis in every environment that runs the suite — see the note at the top of `apps/api/test/health.e2e.test.ts` and `apps/api/test/support/create-test-app.ts`.
- **End-to-end:** Playwright, in `apps/web/e2e`. Builds and starts the real Next.js app, then drives it with a real browser.
- **Full-stack / live database:** CI runs a dedicated job (`live-database-smoke-test`) that starts a real PostgreSQL service and the actual compiled API against it, then polls `/health` and `/ready` — this is the closest equivalent to `docker compose up -d && pnpm db:migrate && pnpm dev` that runs automatically on every change. See `.github/workflows/ci.yml`.

## Money

Every monetary value in this codebase is an integer number of minor units (paise) represented as a `bigint`. There is no floating-point representation of money anywhere. `packages/money` is the only place money arithmetic happens — see its source for `toMinor`, `formatINR`, `percentageOf`, and `sum`. A repo-wide ESLint rule bans `Math.round`, `.toFixed`, and `parseFloat` outside legitimate, individually-justified exceptions (grep for `eslint-disable.*no-restricted-syntax` to review every one).

## Non-negotiable invariants

These hold everywhere in the codebase, from Phase 1 onward. See [PRODUCT/IMPLEMENTATION_HANDOFF.md](PRODUCT/IMPLEMENTATION_HANDOFF.md#non-negotiable-invariants) for the full list and rationale — in short: money is server-computed and integer-only; payment success is only ever established by provider-verified confirmation; every retryable financial operation is idempotent at the database level; authorization is derived from the authenticated principal, never a client-supplied ID; audit records are append-only.

## Contributing

Follow [PRODUCT/docs/16-execution-protocol.md](PRODUCT/docs/16-execution-protocol.md): understand the existing implementation before changing it, implement the smallest change that satisfies the requirement, never weaken a test or guard to make something pass, and report accurately — "tests pass" means you ran them.
