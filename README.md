# Direct-Order

Commission-free direct-ordering platform for independent Indian restaurants. Each restaurant gets a branded ordering link, a real-time order dashboard, online payments, and transparent visibility into every rupee — without giving up 25–35% of order value to an aggregator.

**Status:** Phase 8 (Pricing engine and cart validation) — see [PRODUCT/docs/13-implementation-phases.md](PRODUCT/docs/13-implementation-phases.md). Foundation (Phase 1), core schema and tenancy (Phase 2), authentication (Phase 3), authorization (Phase 4), restaurant creation/onboarding/profile/staff/uploads (Phase 5), menu categories/items (Phase 6), the public ordering page (Phase 7), and the pricing engine + server-side cart validation (Phase 8 — `POST /public/checkout/quote`) are done. A restaurant owner can now sign up, create a restaurant, complete onboarding, invite staff, upload branding images, build out a full categorized menu, set weekly hours, and go live on a real public ordering link where a customer's cart is authoritatively priced and validated server-side — order creation and payments are still Phase 9+.

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
# and worker in parallel, with file watching. apps/api's dev script
# loads the repo-root .env via Node's --env-file flag — it must exist
# (the `cp .env.example .env` step above) before this will boot.
```

Verify the stack is up:

```bash
curl http://localhost:4000/health   # {"status":"ok"}
curl http://localhost:4000/ready    # {"status":"ready","checks":{"database":{"status":"ok",...}}}
open http://localhost:3000          # "Direct-Order" placeholder page
open http://localhost:3000/signup   # Create a restaurant-owner account (Phase 3)
open http://localhost:3000/onboarding # Create and set up a restaurant (Phase 5)
open http://localhost:3000/restaurant/menu # Build out categories and items (Phase 6)
open http://localhost:3000/restaurant/hours # Set weekly hours, closures, ordering toggle (Phase 7)
open http://localhost:3000/r/<slug>         # The live public ordering page for a given restaurant (Phase 7)
                                             # — add an item to the cart and open it to see the
                                             # server-priced breakdown (Phase 8, POST /public/checkout/quote)
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

See [.env.example](.env.example) for the complete list, grouped by concern, each annotated with the phase that introduces the code reading it. Only variables tagged `[PHASE N]` for N ≤ 5 are read by anything that exists today; the rest are documented ahead of time so the full production configuration surface is visible from day one.

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
- **CSRF: double-submit cookie, on top of SameSite=Lax.** A non-HttpOnly `do_csrf_token` cookie is set on every request (`platform/security/csrf-cookie.hook.ts` — a native Fastify `onRequest` hook, deliberately not `NestMiddleware`: chaining two Nest middlewares through `@fastify/middie` produced a real, reproducible "reply.code is not a function" bug under concurrent requests during Phase 5 development). Every non-GET request must echo it back as `X-CSRF-Token`, checked by the globally-registered `CsrfGuard`; `apps/web`'s `api-client.ts` reads the cookie and attaches the header automatically.

## Authorization

Permission catalogue, role definitions, and the tenant-isolation guards (Phase 4, `docs/05-authorization-matrix.md`). Answers the three questions every request must pass: authentication (Phase 3's `AuthGuard`), role capability (`@Permissions(...)`), and resource scope (`@TenantScoped()`).

- **Two decorators, one guard.** A tenant-scoped, permission-gated route declares `@TenantScoped()` and `@Permissions('menu:write')`; `AuthorizationGuard` (`platform/authorization`) reads both. It is **not** a global guard — Nest runs global guards before controller-level ones, and it depends on `AuthGuard` having already populated `request.user`, so every tenant-scoped controller applies both explicitly and in order: `@UseGuards(AuthGuard, AuthorizationGuard)`.
- **403 vs 404, deliberately different layers.** Sending `X-Restaurant-Id` for a restaurant the caller has no active membership in is **403** (`AuthorizationGuard`, logged as a `TENANT_ISOLATION_VIOLATION` audit event). Successfully resolving a tenant and then requesting a specific _resource_ that belongs to a different restaurant is **404**, not 403 — returning 403 would confirm the resource exists, leaking tenant structure (`docs/04-api-specification.md` §8.1). Domain modules get this for free by passing a tenant-scoped repository lookup's `null` result through `assertTenantResourceFound()`.
- **Membership is re-checked per request**, exactly like Phase 3's session liveness check — a staff member disabled mid-session loses access on their very next request, not when their token happens to expire.
- **Only restaurant roles (STAFF/MANAGER/OWNER) are enforceable today.** The permission catalogue also encodes SUPPORT/OPS/FINANCE/SUPER_ADMIN per the documented matrix, but `admin_users` (Phase 13) doesn't exist yet, so no principal can actually hold those roles — a route requiring only an admin-capable permission always denies.
- Proved ahead of any real endpoint via a test-only probe controller (`apps/api/test/authorization.e2e.test.ts`) before Phase 5 attached it to real routes — every `/restaurant/*` controller below uses exactly that pattern.

## Restaurants

Restaurant creation, onboarding, profile/branding/settings, staff invitations, and presigned image uploads (Phase 5, `docs/13-implementation-phases.md`). Every `/restaurant/*` route is `@UseGuards(AuthGuard, AuthorizationGuard)` plus `@TenantScoped()` + `@Permissions(...)` per handler — see Authorization above.

- **`POST /restaurants` creates the tenant** — ownership is always the authenticated principal, and `slug` is optional (auto-derived from `name` with silent `-2`/`-3` disambiguation) or explicit (validated against the reserved-word list and uniqueness, **rejected**, not silently renamed, if either fails — `RestaurantService.validateExplicitSlug`).
- **Onboarding is two independent state machines**, deliberately not one: `Restaurant.onboardingStatus` (the owner's own wizard progress: `IN_PROGRESS` from the moment of creation → `COMPLETED` on submit) and `Restaurant.status` (platform-controlled lifecycle: `DRAFT` → `PENDING_APPROVAL` on submit → `ACTIVE` only once an admin approves, Phase 13). Submitting requires a saved pickup address; both transitions happen server-side in `RestaurantProfileService.submitOnboarding`, so clearing browser storage cannot un-submit or fake completion.
- **Last-active-OWNER protection** (`StaffManagementService`) blocks demoting or disabling a restaurant's sole OWNER with `409 LAST_OWNER` — checked before the (separate) self-demotion guard, so the common case where both would apply surfaces the more specific code.
- **Presigned uploads, two steps.** `POST /restaurant/uploads/presign` validates the _declared_ content type/size (SVG rejected outright, 5 MB cap) and returns a time-limited PUT URL — the API never sees the bytes at this step. `POST /restaurant/uploads/verify` fetches what actually landed in storage afterward and checks the magic bytes match what was declared (`uploads/magic-bytes.ts`), deleting and rejecting on any mismatch — the only way to catch a `.exe` renamed to `.jpg`, since the declared type alone proves nothing.
- **Storage is S3-compatible** (`uploads/s3-storage.adapter.ts`, MinIO locally via `docker-compose.yml`) behind a `StoragePort` interface — tests substitute an in-memory fake (`test/support/fake-storage.ts`) rather than requiring live MinIO.

## Menu

Categories and items, CRUD + archiving + reordering (Phase 6, `docs/13-implementation-phases.md`). Same guard/permission pattern as Restaurants above (`menu:read`/`menu:write`/`menu:availability`).

- **Never hard-deleted.** "Delete" in the UI means archive (`archivedAt` set, `isActive`/`isAvailable` flipped off) — a row a later phase's order references for display context must still exist, per its schema.prisma doc comment.
- **Three states, not one:** `isActive` (on the menu) · `isAvailable` (orderable right now — the one field STAFF, not just MANAGER/OWNER, can toggle: `PATCH /restaurant/menu/items/:id/availability` is `menu:availability`, every other write is `menu:write`) · `archivedAt` (removed, retained for history). Don't conflate them.
- **Reordering is one transaction, validated before any write.** `POST /restaurant/menu/{categories,items}/reorder` first checks every id in the batch belongs to the caller's tenant; an unknown or foreign id fails the whole request with the previous order completely intact, rather than applying a prefix of the batch.
- **Category name uniqueness (among non-archived rows) is enforced at the service layer, not a DB constraint** — Prisma's schema DSL can't express a partial unique index, the same limitation already noted for `User`'s email-or-phone invariant.
- **Frontend reordering is dual-input:** native HTML5 drag-and-drop for mouse users, plus keyboard-focusable ▲/▼ buttons that do the same reorder call — an `aria-live` region announces the result for screen readers, since a drag's visual reshuffle is otherwise silent to them.

## Availability and the public ordering page

`isAcceptingOrders()` (Phase 7, `apps/api/src/modules/availability/availability.service.ts`) is **the single authority** on whether a restaurant can take an order right now — consumed by the public page today, and by search's "open now" filter and checkout revalidation once those phases exist, so all three always agree (docs/03-state-machines.md, BR-66).

- **Precedence, first match wins:** `Restaurant.status` → an active `ClosurePeriod` → `SpecialHours` (a date-specific override, if one exists for that date — replaces `OperatingHours` for that day entirely, doesn't merge with it) → `OperatingHours` (the weekly recurring schedule, overnight shifts spanning midnight supported) → `Restaurant.orderingEnabled`. A restaurant with `status: SUSPENDED` can never make itself orderable by flipping `orderingEnabled` — `status` is checked first, unconditionally.
- **Everything is evaluated in the restaurant's own IANA timezone**, via `Intl.DateTimeFormat`, never the server's — see `availability/timezone.ts`. `OperatingHours.opensAt`/`closesAt` are Postgres `TIME` columns (wall-clock time-of-day only), round-tripped through an epoch-date convention documented in `availability/time-of-day.ts`.
- **Restaurant-facing management:** `GET/PUT /restaurant/hours` (full weekly replace, MANAGER+), `GET/POST/DELETE /restaurant/closures` (temporary closures — `DELETE` ends one early by setting `endsAt`, never a hard delete), `PATCH /restaurant/availability` (the `ordering_enabled` toggle, STAFF-permitted). `SpecialHours` has no restaurant-facing write endpoint yet (not in docs/04-api-specification.md §8.5) — the table and the precedence logic are fully built and tested; a later phase can add the write path without touching the authority function.
- **`GET /public/restaurants/:slug` and `/menu`** (`apps/api/src/modules/public/`) are unauthenticated and slug-keyed — the highest-risk leak surface in the API, so the response is an explicit field allowlist, never a spread of the Prisma row (asserted directly in `public.e2e.test.ts`). DRAFT/PENDING_APPROVAL restaurants 404 exactly like a nonexistent slug; ACTIVE/SUSPENDED/CLOSED are all visible (200) with a non-accepting `availability` decision for the latter two, so a bookmarked link still explains itself instead of just disappearing.
- **The customer page** (`apps/web/src/app/r/[slug]/`) is a real Server Component with dynamic metadata/Open Graph tags — not a client-side spinner. The cart is client-side, persisted to `localStorage` under a **per-slug key**, which is what makes "switching restaurants never mixes their items" true by construction rather than a runtime check. In-page search filters the already-fetched menu client-side; there is no separate search endpoint (cross-restaurant discovery is feature-flagged off, BR-146).
- **Playwright coverage runs against a mock API**, not a live database (`apps/web/e2e/support/mock-public-api-server.mjs`, wired in via a second `webServer` entry in `playwright.config.ts`) — this sandbox has no Docker/Postgres to seed a real restaurant against. Actually running `pnpm test:e2e` end-to-end for (apparently) the first time in this environment surfaced a real, unrelated pre-existing gap: every page mounts `SessionProvider` (Phase 3), which checks `GET /auth/me` on load — Chrome itself logs any non-2xx resource load as a console error regardless of how gracefully the app handles the response, so `smoke.spec.ts`'s original "zero console errors" assertion was never actually compatible with a logged-out visit once that session check existed. Fixed by allowing exactly that one expected, benign 401 message rather than loosening the assertion generally.

## Pricing engine and cart validation

The pricing engine (`packages/money/src/pricing.ts`, `calculatePricing()`) is **the single place order totals are computed** — Phase 8 builds it and `POST /public/checkout/quote`; Phase 9's real checkout, and every later phase that touches a total (promotion redemption, loyalty redemption, refund calculation), calls this same function rather than re-deriving one.

- **BR-3:** `payableTotalMinor = itemsSubtotal + packagingFee + deliveryFee + platformFee + tax − discount`, discount being promotion + loyalty, combined and capped so it can never exceed the discountable base (BR-7) or push the total negative (BR-6). Promotion is clamped against the base first, loyalty against whatever remains — a deterministic priority order, not a simultaneous split.
- **BR-5:** every percentage (tax, a percentage-type promotion, the platform fee) is rounded half-up to the nearest paise **once**, at the point of calculation — reusing `percentageOf()` from Phase 1, never re-rounding a later sum.
- **Platform fee is basis points of the subtotal** (`PLATFORM_FEE_BPS`, global config, default 0 — BR-14: zero renders as an absent line, not a "₹0 platform fee" one), not per-restaurant; no `RestaurantSettings` field exists for this.
- **`POST /public/checkout/quote`** runs the pricing-relevant subset of the mandated checkout sequence (docs/04-api-specification.md §8.3: availability, live item state, price-drift detection, minimum order, then pricing) without the parts that need infrastructure this phase doesn't build — a persisted cart (`POST /public/carts`, Phase 9), coupon/loyalty reservation (Phase 14/16), or order creation (Phase 9). It takes cart contents directly in the request body rather than a `cartId`. Issues (`ITEM_UNAVAILABLE`, `PRICE_CHANGED`, `BELOW_MINIMUM_ORDER`, `RESTAURANT_UNAVAILABLE`) come back in a 200 response, not a single fatal error — `valid: false` is what actually blocks proceeding, and the breakdown is still computed from whatever items passed validation.
- **The frontend cart** (`apps/web/src/app/r/[slug]/restaurant-ordering-view.tsx`) re-quotes on every cart change and renders the server-computed breakdown plus any issue messages — there is no client-side price estimate anywhere; the number shown is always what the server just said.
- **Tax has no restaurant-level config yet** (BR-15 is explicitly flagged as needing real tax advice) — the engine supports a `taxPercent` input and is fully tested against it, but the live endpoint always passes none, the same "build it, don't wire it to a guess" treatment `SpecialHours` got in Phase 7.

## Testing

- **Unit / integration:** Vitest, per workspace (`apps/api/test`, `packages/money/test`, ...). API integration tests boot a real NestJS + Fastify application over real HTTP (via supertest); `PrismaService` and `RedisService` are overridden with in-memory stand-ins (`apps/api/test/support/`) rather than requiring a live database and Redis in every environment that runs the suite — see the note at the top of `apps/api/test/health.e2e.test.ts` and `apps/api/test/support/create-test-app.ts`.
- **End-to-end:** Playwright, in `apps/web/e2e`. Builds and starts the real Next.js app, then drives it with a real browser. `ordering.spec.ts` (Phase 7) is the first real customer-journey coverage: valid/invalid slugs, sold-out items, cart persistence across a reload, cross-restaurant cart isolation, in-page search, and a keyboard-only pass through the browse flow — run against the mock API server described above.
- **Full-stack / live database:** CI runs a dedicated job (`live-database-smoke-test`) that starts a real PostgreSQL service and the actual compiled API against it, then polls `/health` and `/ready` — this is the closest equivalent to `docker compose up -d && pnpm db:migrate && pnpm dev` that runs automatically on every change. See `.github/workflows/ci.yml`.

## Money

Every monetary value in this codebase is an integer number of minor units (paise) represented as a `bigint`. There is no floating-point representation of money anywhere. `packages/money` is the only place money arithmetic happens — see its source for `toMinor`, `formatINR`, `percentageOf`, `sum`, and (Phase 8) the pricing engine, `calculatePricing`. A repo-wide ESLint rule bans `Math.round`, `.toFixed`, and `parseFloat` outside legitimate, individually-justified exceptions (grep for `eslint-disable.*no-restricted-syntax` to review every one).

## Non-negotiable invariants

These hold everywhere in the codebase, from Phase 1 onward. See [PRODUCT/IMPLEMENTATION_HANDOFF.md](PRODUCT/IMPLEMENTATION_HANDOFF.md#non-negotiable-invariants) for the full list and rationale — in short: money is server-computed and integer-only; payment success is only ever established by provider-verified confirmation; every retryable financial operation is idempotent at the database level; authorization is derived from the authenticated principal, never a client-supplied ID; audit records are append-only.

## Contributing

Follow [PRODUCT/docs/16-execution-protocol.md](PRODUCT/docs/16-execution-protocol.md): understand the existing implementation before changing it, implement the smallest change that satisfies the requirement, never weaken a test or guard to make something pass, and report accurately — "tests pass" means you ran them.
