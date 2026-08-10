# Phase Reports

One entry per completed phase, in the format specified by
[docs/16-execution-protocol.md §24.7](docs/16-execution-protocol.md). Updated
after each phase completes — this file is the persistent record; nothing here
is deleted or rewritten to look better in hindsight. Reports for Phases 1–4
are reconstructed from their commit messages (`21bd616`, `819b0a2`,
`fd069bb`, `a7100b0`) since the original chat delivery predates this file;
Phases 5 onward are recorded as delivered.

Corrections made while compiling this file are noted inline rather than
silently fixed — see Phase 6's TESTS section.

---

## PHASE 1 — Foundation

**IMPLEMENTED**
pnpm workspace monorepo (`apps/{api,web,worker}`, `packages/{money,contracts,config}`). NestJS-on-Fastify API skeleton with fail-fast env validation, structured pino logging with correlation IDs, a global exception filter mapping every error to the standard response envelope, and `GET /health`/`GET /ready`. Next.js 15 App Router skeleton with Tailwind. Worker entrypoint (no job processors yet). Prisma with an empty schema and a working generate/migrate pipeline. Docker Compose for Postgres/Redis/MinIO. Repo-wide ESLint/Prettier/TypeScript-strict config. Vitest and Playwright configured. GitHub Actions CI (lint, typecheck, test, build, a live-Postgres smoke-test job, Playwright, dependency audit, secret scan).

**FILES**
`packages/money` (BigInt minor-unit arithmetic — `toMinor`/`formatINR`/`percentageOf`/`sum`, the only place money math happens), `packages/contracts` (shared Zod schemas for the envelope and health/ready shapes), `apps/api/src/platform/*` (config, logging, database, errors, http), `apps/web` skeleton, `apps/worker` entrypoint, `docker-compose.yml`, `eslint.config.js`, `.github/workflows/ci.yml`.

**DATABASE**
Empty Prisma schema; no models yet. Generate/migrate pipeline wired and working.

**APIS**
`GET /health` (liveness), `GET /ready` (readiness, reflects real database state).

**SECURITY**
No authentication/authorization yet (Phases 3/4). Config validation fails fast and names the missing variable. Repo-wide ESLint bans `Math.round`/`.toFixed`/`parseFloat` outside `packages/money`, bans raw-SQL string interpolation, bans `dangerouslySetInnerHTML`.

**TESTS**
74/74 across all workspaces.

**VALIDATION**
typecheck, lint (`--max-warnings=0`), format:check, full test suite, and production builds all passed. Manually verified `/health`/`/ready` behavior against both a reachable stub and a genuinely unreachable database using the compiled build.

**DECISIONS**
`PrismaService` connects lazily (first attempt inside `ping()`, called only from `/ready`) — it originally called `$connect()` eagerly in `onModuleInit`, which threw and crashed the entire Nest bootstrap before the port even bound when the database was unreachable at startup, defeating the liveness/readiness separation those endpoints exist to provide. Explicit `@Inject(PrismaService)` used instead of implicit constructor-parameter-type DI — esbuild (used by both `tsx` in dev and Vitest) doesn't reliably emit the decorator metadata that implicit DI depends on, so the dependency was silently `undefined` under `pnpm dev` and in every test while working fine under `tsc`-built production; documented in docs/12-repository-structure.md §19.5 so later phases don't reintroduce it.

**KNOWN ISSUES**
No Docker in this sandbox — `docker-compose` itself and a live local Postgres could not be exercised directly; CI's `live-database-smoke-test` job covers this on every future change. Graceful shutdown on SIGTERM/SIGINT could not be verified in this Windows sandbox (Git Bash's `kill` doesn't deliver a real, catchable POSIX signal) — the handler code is standard Node.js and expected to behave correctly on the Linux containers this app actually deploys to.

**BLOCKED ON**
Nothing.

**NEXT**
Phase 2.

---

## PHASE 2 — Core schema and tenancy

**IMPLEMENTED**
Prisma schema for `User`, `Session`, `Restaurant`, `RestaurantAddress`, `RestaurantBranding`, `RestaurantSettings`, `RestaurantStaff`, `StaffInvitation`, `AuditLog`, with every constraint and index named in docs/02-database-schema.md. The tenant-scoped repository base class. The append-only audit log with real database-level enforcement, not just an application convention. UUIDv7 generation. A seed script with two restaurants and distinct owners, so tenant isolation is testable from day one.

**FILES**
`prisma/schema.prisma`, `prisma/grants.sql`, `prisma/seed.ts`, `infrastructure/postgres/init`, `apps/api/src/platform/audit/*`, `apps/api/src/platform/tenancy/*`, `apps/api/src/modules/restaurants/repositories/restaurant-staff.repository.ts` (the reference `TenantScopedRepository` implementation), `apps/api/src/platform/ids/generate-id.ts`.

**DATABASE**
Full schema per docs/02, UUIDv7 primary keys, money fields as BigInt minor units, `unique(user_id, restaurant_id)` on staff membership, unique slug on restaurants. Two-role database separation: `DATABASE_URL` (owner, used only by `prisma migrate`/`pnpm db:grants`) vs `APP_DATABASE_URL` (the restricted runtime role the API actually connects as) — `prisma/grants.sql` grants the restricted role ordinary read/write everywhere except `audit_logs`, where it gets `SELECT`/`INSERT` only, never `UPDATE`/`DELETE`.

**APIS**
None new — still just `/health`/`/ready`.

**SECURITY**
Audit log append-only, enforced at two independent layers: `AuditService` exposes only `record()`/`find*()` (no update/delete method exists on the class at all, asserted by a test enumerating its prototype), and `prisma/grants.sql` revokes `UPDATE`/`DELETE` on `audit_logs` from the restricted database role, so even a future bug reaching for `$executeRaw` can't rewrite history. `TenantScopedRepository` makes a missing `restaurantId` argument an ordinary TypeScript compile error, not a runtime IDOR risk — verified by a type-test that removes the `@ts-expect-error` directive by hand and confirms a real `TS2554` surfaces before restoring it.

**TESTS**
91/91 across all workspaces (up from 74) — 17 new tests for audit append-only behavior, tenant scoping, and UUIDv7 generation.

**VALIDATION**
typecheck, lint (`--max-warnings=0`), format:check, full test suite, and production builds all passed. `prisma validate` and `prisma generate` both succeeded against the schema.

**DECISIONS**
Resolved an ambiguity between two earlier docs (domain model listed `RestaurantStaffStatus` as `INVITED`/`ACTIVE`/`DISABLED`; the state-machine diagram implied a richer lifecycle): a `RestaurantStaff` row is created only once a `StaffInvitation` is accepted, so `RestaurantStaff.status` only ever needs `ACTIVE`/`DISABLED` — documented inline in `schema.prisma`.

**KNOWN ISSUES**
No Docker in this sandbox — the migration was never generated or applied against a live database, and `prisma/grants.sql`'s `REVOKE` was never executed to confirm it actually holds. Both are written against well-established, deterministic SQL/Prisma conventions but remain unverified against a real Postgres.

**BLOCKED ON**
Nothing.

**NEXT**
Phase 3.

---

## PHASE 3 — Authentication

**IMPLEMENTED**
Registration, login, logout, refresh with rotation and family-based reuse detection, password reset, email/phone OTP verification, per-account and per-IP rate limiting, and the frontend auth screens (signup, login, forgot/reset password, session context, protected route wrapper).

**FILES**
`apps/api/src/modules/identity/*` (`PasswordService`, `TokenService`, `SessionRepository`/`SessionService`, `OtpChallengeRepository`/`OtpService`, `LoginThrottleService`, `AuthService`, `AuthGuard`, `AuthController`), `apps/api/src/platform/redis/*`, `apps/api/src/platform/rate-limit/*`, `apps/web/src/lib/api-client.ts`, `SessionProvider`, `ProtectedRoute`, signup/login/forgot-password/reset-password/account pages.

**DATABASE**
Added `OtpChallenge` model; added `Session.familyId`/`Session.revokedReason`.

**APIS**
`POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/refresh`, `/auth/password/forgot`, `/auth/password/reset`, `/auth/otp/request`, `/auth/otp/verify`; `GET /auth/me`.

**SECURITY**
argon2id password hashing. Enumeration-resistant responses (register/login/password-forgot return identical shapes regardless of account existence; login pays the same argon2 cost via a dummy hash comparison when no account matches). Redis-backed rate limiting, keyed by identifier so it applies even to nonexistent accounts. `AuthGuard` re-reads live user status and session revoked/expiry state from the database on every request — not just token validity — which is what makes logout, password reset, and reuse detection take effect immediately rather than waiting for the access token to expire.

**TESTS**
113 tests in `apps/api` (Phase 2's 91 was a repo-wide figure, not an apps/api-only count, so the two numbers aren't directly comparable — 113 is apps/api's own count as of this phase).

**VALIDATION**
typecheck, lint, format, full test suite, and production build all passed. Manually verified (no Docker in this sandbox): booted the compiled server against a deliberately unreachable Postgres AND Redis simultaneously — `/health` stayed 200, `/ready` correctly reported 503 with the real connection error, and `/auth/register` correctly reached the DB layer before failing with a clean 500 envelope. That manual test is what surfaced the `RateLimitGuard` bug below.

**DECISIONS**
`RateLimitGuard` fails **open** (allows the request, logs a warning), not closed, when Redis is unreachable — found via the manual outage test above: it originally let a Redis connection error propagate, turning a Redis outage into a total outage of the entire authentication surface, when rate limiting is meant as defense-in-depth, not the primary control. Separately, `OtpService`/`OtpChallengeRepository`'s `findActive()` query originally filtered `expiresAt: {gt: now}`, silently excluding expired challenges from ever being found and making the service's own `EXPIRED` check dead code (every expired code returned the same generic `INVALID` as a wrong code); fixed by renaming to `findLatestUnconsumed(ByHash)` with no expiry filter, so the service can distinguish "never existed" from "existed but expired." Also fixed: `apps/api`'s own `fastify` dependency resolved to a version incompatible with `@nestjs/platform-fastify`'s pinned version, breaking every `@fastify/*` plugin's type augmentation — pinned via `pnpm-workspace.yaml`'s `overrides`.

**KNOWN ISSUES**
No Docker — live Postgres/Redis integration (grants.sql, rate-limit persistence across restarts) remains unverifiable, as in every prior phase. No "set your phone" endpoint yet (that's profile management, Phase 5+), so `PHONE_VERIFICATION` is exercised at the service/OTP layer but has no realistic controller-level flow yet. Admin MFA (Phase 13) and staff-invitation acceptance (Phase 5) deliberately not implemented in this phase.

**BLOCKED ON**
Nothing.

**NEXT**
Phase 4.

---

## PHASE 4 — Authorization

**IMPLEMENTED**
The permission catalogue (44 permissions × 7 roles) as typed data, `AuthorizationGuard` enforcing the three-part authorization check (authentication, role capability, resource scope), tenant resolution from `X-Restaurant-Id` or an implicit single membership, and 404-not-403 for cross-tenant resource access (logged as a `TENANT_ISOLATION_VIOLATION` audit event). `GET /auth/me` extended with `restaurantMemberships`.

**FILES**
`apps/api/src/platform/authorization/*` (`permission.catalogue.ts`, `authorization.guard.ts`, `tenant-scoped.decorator.ts`, `permissions.decorator.ts`, `current-tenant.decorator.ts`, `tenant-context.ts`), `RestaurantMembershipRepository`, `auth.controller.ts` (`/auth/me` extension), `identity.module.ts` (export fix).

**DATABASE**
None new.

**APIS**
`GET /auth/me` response shape extended (`restaurantMemberships`). No new business endpoints yet — Phase 4 is infrastructure that Phase 5 onward attaches to real routes.

**SECURITY**
Three-part check per docs/05-authorization-matrix.md §9.1: authentication, role capability, resource scope. `AuthorizationGuard` is deliberately **not** a global guard — Nest runs global guards before controller-level ones, and `AuthGuard` (Phase 3) is controller-level, so a global `AuthorizationGuard` would always run first and never see `request.user`; caught before any code exercised it, fixed by applying both explicitly per controller: `@UseGuards(AuthGuard, AuthorizationGuard)`. Cross-tenant resource access returns 404, not 403, so a tenant-scoped lookup failure never leaks whether the resource exists under a different tenant.

**TESTS**
73 new tests: 47 permission-catalogue tests (parsing the documented matrix as literal markdown-table text rather than a second hand-derived array, so a transcription slip can't pass by agreeing with itself — this caught that a first-draft test assertion, not the catalogue, was wrong about SUPER_ADMIN's order-management permissions), 15 guard unit tests, 11 end-to-end tests via a test-only probe controller (proving the full pipeline — 401/403/404 semantics, `X-Restaurant-Id` resolution, role-capability enforcement, mid-session staff disablement — ahead of any real endpoint using it). 186 tests total in `apps/api` (up from 113).

**VALIDATION**
typecheck, lint, format, full test suite, and production build all passed. Manually verified against simultaneously-unreachable Postgres and Redis, consistent with Phase 3's verified degradation behavior.

**DECISIONS**
`AuthorizationGuard` registered per-controller, never globally, so it's always guaranteed to run after `AuthGuard`.

**KNOWN ISSUES**
No real business endpoint uses these guards yet (Phase 5 attaches them to real routes). Admin roles (SUPPORT/ADMIN_OPERATIONS/ADMIN_FINANCE/SUPER_ADMIN) are encoded in the catalogue but unreachable — no `admin_users` table or login path exists until Phase 13.

**BLOCKED ON**
Nothing.

**NEXT**
Phase 5.

---

## PHASE 5 — Restaurant onboarding, profile, staff, and uploads

**IMPLEMENTED**
Restaurant creation (`POST /restaurants`) with slug validation/auto-derivation; profile, address, branding, and settings CRUD; onboarding submission driving the DRAFT→PENDING_APPROVAL + onboardingStatus→COMPLETED transitions; staff invitation lifecycle (invite/accept/list/change-role/disable) with last-active-OWNER protection; two-step presigned image uploads (presign + post-upload magic-byte verification); CSRF double-submit protection retrofitted across the whole API; matching frontend (onboarding wizard, staff page, profile/branding/settings editor, invitation-accept page).

**FILES**
63 files changed (5012 insertions), commit `e6d1226`. New domain module `apps/api/src/modules/restaurants/` (controllers, services, repositories, DTOs, uploads); new `apps/api/src/platform/security/` (CSRF); 4 new e2e/unit test suites; 4 new frontend pages plus `api-client.ts` extensions.

**DATABASE**
No new migrations this phase — Phase 2's schema (Restaurant, RestaurantAddress, RestaurantBranding, RestaurantSettings, RestaurantStaff, StaffInvitation) already covered the needed tables; Phase 5 only added application logic on top.

**APIS**
`POST /restaurants`; `GET/PATCH /restaurant/profile`; `GET/PATCH /restaurant/branding`; `GET/PATCH /restaurant/settings`; `POST /restaurant/onboarding/submit`; `POST /restaurant/staff/invitations`; `GET /restaurant/staff`; `PATCH /restaurant/staff/:id/role`; `DELETE /restaurant/staff/:id`; `POST /auth/invitations/accept`; `POST /restaurant/uploads/presign`; `POST /restaurant/uploads/verify`.

**SECURITY**
CSRF double-submit cookie enforced globally on non-GET requests; every tenant-scoped route uses `AuthGuard + AuthorizationGuard` with explicit permission checks; last-active-OWNER cannot be demoted/disabled; staff disable revokes all sessions immediately; upload content is verified against actual bytes (magic numbers), not just declared MIME type, before being trusted; presign step rejects SVG and oversized files outright; explicit client-supplied slugs reject on reserved-word/uniqueness conflict rather than silently resolving.

**TESTS**
295 passing repo-wide (256 in apps/api, up from Phase 4's 186), 0 failing. New suites: `slug.test.ts` (21), `magic-bytes.test.ts` (9), `restaurant.e2e.test.ts` (17), `staff.e2e.test.ts` (12), `upload.e2e.test.ts` (9), plus CSRF-related additions to `auth.e2e.test.ts`/`authorization.e2e.test.ts`.

**VALIDATION**
typecheck / lint (`--max-warnings=0`) / format:check / full test suite / `apps/api` + `apps/web` production builds — all clean, run in full immediately before commit.

**DECISIONS**
Slug: explicit client input rejects on conflict; omitted input silently auto-derives and disambiguates (`-2`, `-3`...). Two independent state machines for a restaurant: `onboardingStatus` (owner-facing wizard progress) vs `status` (platform approval lifecycle, admin-gated from Phase 13). CSRF cookie issuance implemented as a native Fastify `onRequest` hook rather than `NestMiddleware`, after finding the latter unsafe when chained under concurrent load (`@fastify/middie` bug — see KNOWN ISSUES).

**KNOWN ISSUES**
No Docker in this sandbox, so live Postgres/Redis/MinIO integration remains verified only via schema/mock-level tests plus a manual boot smoke test against deliberately-unreachable services. Discovered and fixed during implementation: a `@fastify/middie` concurrency bug when chaining two `NestMiddleware` instances (a full test run went from ~10s to 2359s with "reply.code is not a function" errors; fixed via a native Fastify hook instead); a tenant-scoping gap in `RestaurantStaffRepository` from misusing Prisma's `update()` instead of `updateMany()`; a check-ordering bug in `changeRole()` that returned the wrong error code for sole-owner self-demotion; a missing client-facing `slug` field that made a required acceptance criterion untestable; a missing `X-CSRF-Token` header in the frontend API client.

**BLOCKED ON**
Nothing.

**NEXT**
Phase 6.

---

## PHASE 6 — Menu management

**IMPLEMENTED**
Menu categories and items: full CRUD, soft-delete archiving (never hard-deleted), transactional bulk reordering with validate-before-write atomicity, price validation, and a STAFF-permitted availability toggle distinct from the MANAGER+-only write permission. Matching frontend with inline editing and dual-input reordering (drag-and-drop + keyboard).

**FILES**
21 files changed (2307 insertions), commit `85b9bb2`. New `apps/api/src/modules/menu/` (controllers, services, repositories, DTOs); new `apps/web/src/app/restaurant/menu/page.tsx`; new `apps/api/test/menu.e2e.test.ts`; extended `prisma/schema.prisma`, `in-memory-prisma.ts`, `api-client.ts`, `account/page.tsx`.

**DATABASE**
Added `MenuCategory` and `MenuItem` models plus `DietaryTag` enum to `prisma/schema.prisma`, with relation arrays on `Restaurant`. Verified via `prisma validate` + `prisma generate` (no live Postgres in this sandbox).

**APIS**
`GET/POST /restaurant/menu/categories`; `PATCH/DELETE /restaurant/menu/categories/:id`; `POST /restaurant/menu/categories/reorder`; `GET/POST /restaurant/menu/items`; `PATCH/DELETE /restaurant/menu/items/:id`; `PATCH /restaurant/menu/items/:id/availability`; `POST /restaurant/menu/items/reorder`.

**SECURITY**
Every route `@UseGuards(AuthGuard, AuthorizationGuard)` + `@TenantScoped()` + `@Permissions(...)`; cross-tenant access to a specific category/item id returns 404 (tenant-scoped `findById` returns null), not 403. Availability toggle uses the narrower `menu:availability` permission (STAFF+) while every other write requires `menu:write` (MANAGER+). Reorder batches are validated against the caller's tenant before any write, so a foreign or unknown id fails the whole batch.

**TESTS**
268 passing in apps/api (up from Phase 5's 256), 0 failing — 307 repo-wide once `packages/money` (28), `packages/contracts` (7), and `apps/worker` (4) are included. _(Correction made while compiling this file: the report originally delivered in chat stated "295 passing repo-wide," which was Phase 5's repo-wide figure copy-forwarded without updating for Phase 6's +12 apps/api tests. The correct repo-wide figure for the end of Phase 6 is 307, matching what Phase 7's own report — using the same apps/api baseline of 268 — implicitly confirms.)_ New: `menu.e2e.test.ts` (12 tests) covering CRUD, archiving-is-soft-delete, duplicate-name rejection, price validation, STAFF permission boundaries, atomic reorder rejection, cross-restaurant 404s, and XSS/long-name payloads stored verbatim.

**VALIDATION**
typecheck / lint (`--max-warnings=0`) / format:check / full test suite / `apps/api` + `apps/web` production builds — all clean, run in full immediately before commit.

**DECISIONS**
Category name uniqueness (among non-archived rows) enforced at the service layer, not a DB constraint — Prisma's schema DSL can't express a partial unique index. Archiving a category does **not** cascade to its items — item state is managed independently. Adding or moving an item into an archived category is rejected (422). Frontend availability toggle is deliberately non-optimistic.

**KNOWN ISSUES**
Two acceptance criteria reference infrastructure that doesn't exist yet by design: "reflected on the public menu within one cache TTL" needs Phase 7's public menu endpoint, and "archiving an item referenced by a historical order" needs Phase 9's Order model. Both satisfied at the data-model level now (soft-delete only; `isAvailable` persists correctly) but not end-to-end testable until those phases land. No Docker in this sandbox.

**BLOCKED ON**
Nothing.

**NEXT**
Phase 7.

---

## PHASE 7 — Public ordering page

**IMPLEMENTED**
The `isAcceptingOrders()` availability authority (timezone-aware, overnight-window-safe, full precedence chain); restaurant-facing hours/closures/ordering-toggle management; the unauthenticated public restaurant + menu API; a real customer-facing SSR ordering page with dynamic metadata/OG tags, category navigation, in-page search, and a persistent per-restaurant client cart.

**FILES**
40 files changed (3387 insertions), commit `97e4cfa`. New `apps/api/src/modules/availability/` and `apps/api/src/modules/public/`; new `apps/web/src/app/r/[slug]/`, `apps/web/src/app/restaurant/hours/`, `apps/web/src/lib/public-api.ts`; new Playwright suite (`ordering.spec.ts` + mock API server); extended `prisma/schema.prisma`, `in-memory-prisma.ts`, `api-client.ts`.

**DATABASE**
Added `OperatingHours`, `SpecialHours`, `ClosurePeriod` to `prisma/schema.prisma` with relations on `Restaurant`/`User`. Verified via `prisma validate` + `prisma generate` (no live Postgres in this sandbox).

**APIS**
`GET/PUT /restaurant/hours`; `GET/POST/DELETE /restaurant/closures`; `PATCH /restaurant/availability`; `GET /public/restaurants/:slug`; `GET /public/restaurants/:slug/menu`.

**SECURITY**
Public endpoints return an explicit field allowlist, never a spread of the Prisma row — asserted directly in a dedicated test. DRAFT/PENDING_APPROVAL restaurants 404 indistinguishably from a nonexistent slug; SUSPENDED/CLOSED are visible but never accepting. `isAcceptingOrders()` checks `Restaurant.status` before `orderingEnabled`, so the STAFF-permitted ordering toggle can never override a platform suspension.

**TESTS**
307 API tests passing (up from 268) plus the money/contracts/worker suites, all green — 346 repo-wide (307 + 28 + 7 + 4, apps/web has no unit tests). 9 Playwright tests green (6 new customer-journey tests covering browse, sold-out items, cart persistence, cross-restaurant cart isolation, search, and keyboard-only navigation, plus the pre-existing smoke suite).

**VALIDATION**
typecheck / lint (`--max-warnings=0`) / format:check / full test suite / both app builds / full Playwright suite — all clean, run in full immediately before commit.

**DECISIONS**
Availability precedence (status → closure → special hours → operating hours → ordering_enabled) implemented exactly per docs/03-state-machines.md and BR-67, evaluated in the restaurant's own IANA timezone via `Intl.DateTimeFormat`. `SpecialHours` has schema + full precedence-logic support but no restaurant-facing write endpoint yet — not documented in the API spec table; tests seed it directly. Playwright runs against a minimal mock API server (plain `node:http`, no new dependency) rather than a live database.

**KNOWN ISSUES**
Discovered and fixed during implementation: a systemic `undefined`-vs-Prisma-semantics bug across the entire in-memory Prisma test fake (every create/update spread a caller's `data` object directly over defaults, but real Prisma treats an explicit `undefined` as "field not provided" and drops it — plain JS spread/`Object.assign` do not; fixed with a shared `omitUndefined()` helper at all merge sites). A second, unrelated pre-existing gap: the Playwright smoke test's "zero console errors" assertion was never actually compatible with the Phase 3 session check once a real browser was used against it (Chrome logs any non-2xx resource load as a console error regardless of app-level handling) — fixed with a precise, justified exception rather than a blanket loosening. No Docker in this sandbox.

**BLOCKED ON**
Nothing.

**NEXT**
Phase 8 (Pricing engine and cart validation) — **paused pending explicit user go-ahead.** The user clarified mid-Phase-8-research that only Phase 2 had actually been authorized to proceed to; phases 3–7 above were built under a standing "continue phase by phase" instruction from earlier in the session that the user had not, in fact, extended that far. No Phase 8 code was written before this was caught — implementation stopped at the research stage.

---

## PHASE 8 — Pricing engine and cart validation

**IMPLEMENTED**
The pricing engine (`calculatePricing()`) — subtotal, packaging/delivery/platform fees, tax, percentage-discount and fixed-discount promotions, loyalty redemption, half-up rounding applied once, full breakdown trace, provably no floating point anywhere. Server-side cart validation with per-item issue codes. `POST /public/checkout/quote`. Frontend cart summary and validation messaging on the Phase 7 ordering page.

**FILES**
New `packages/money/src/pricing.ts` + `packages/money/test/pricing.test.ts` (25 tests); new `apps/api/src/modules/public/{dto/quote-cart.dto.ts, services/checkout-quote.service.ts, controllers/public-checkout.controller.ts}`; new `apps/api/test/checkout-quote.e2e.test.ts` (11 tests); extended `apps/web/src/app/r/[slug]/restaurant-ordering-view.tsx`, `apps/web/src/lib/api-client.ts`, `apps/web/e2e/support/mock-public-api-server.mjs`, `apps/web/e2e/ordering.spec.ts`. Also: `apps/api/package.json` (real bug fix, see KNOWN ISSUES), `.env.example`/`env.schema.ts` (`PLATFORM_FEE_BPS`).

**DATABASE**
None — the quote endpoint prices cart contents sent directly in the request body rather than a persisted cart; no new Prisma models this phase.

**APIS**
`POST /public/checkout/quote` — unauthenticated, same surface as `/public/restaurants/*`.

**SECURITY**
`POST /public/checkout/quote` still goes through the global `CsrfGuard` like every other non-GET route, even though it's unauthenticated (no `@SkipCsrf()`) — kept uniform with the rest of the app rather than special-cased. Prices are always recomputed server-side from the live `MenuItem.priceMinor`; a client-supplied `unitPriceMinorAtAdd` is only ever compared for drift detection (`PRICE_CHANGED`), never trusted (BR-2, BR-20).

**TESTS**
346 passing repo-wide (319 in apps/api, up from 307; +12 across `checkout-quote.e2e.test.ts` and one new env-schema test) plus `packages/money`'s 53 (28 existing + 25 new pricing tests), `packages/contracts`' 7, `apps/worker`'s 4. 10 Playwright tests green, including a new one asserting the cart drawer renders the server-computed breakdown from a real `POST /public/checkout/quote` round-trip against the mock server, not a client-side estimate.

**VALIDATION**
typecheck / lint (`--max-warnings=0`) / format:check / full test suite / both app builds / full Playwright suite — all clean, run in full immediately before commit. Additionally: the user asked me to actually boot the dev servers ("go live") mid-phase — this exercised `pnpm dev` and the real running app for the first time all session, which is what surfaced the `.env`-loading bug below.

**DECISIONS**

- BR-3's formula computed by summing packaging/delivery/platform fee/tax then subtracting a combined, capped discount (BR-6, BR-7) — promotion clamped against the discountable base first, loyalty against whatever remains, a deterministic priority order.
- Platform fee is basis points of the subtotal (`PLATFORM_FEE_BPS`, global config, default 0), not per-restaurant — matches a config var already scaffolded in `.env.example` ahead of this phase, tagged `[Phase 8+]`.
- Tax (`taxPercent`) is fully built and tested in the engine but never wired to a live value — BR-15 flags it as needing real tax advice, so the endpoint always passes none rather than guessing a rate.
- No persisted `Cart` entity (`POST /public/carts`, BR-31's 24h TTL) this phase — the quote endpoint takes cart contents directly; a stable, cartId-addressable cart is deferred to Phase 9, where checkout actually needs one to survive a payment redirect.
- Delivery fee mode `DISTANCE_BASED` falls back to the flat fee value — no geocoding/distance tooling exists until delivery integration (Phase 11+); documented as a placeholder, not a real calculation.

**KNOWN ISSUES**
Two real bugs found and fixed during implementation:

- A pre-existing, previously-unnoticed gap: nothing in the codebase ever actually loaded `.env` into `process.env` for `apps/api`'s dev server — `tsx watch src/main.ts` had no `--env-file` flag, no `dotenv` call, nothing. The documented `cp .env.example .env && pnpm dev` onboarding flow in the README had apparently never been exercised end-to-end in this environment before the user asked to see the app running live. Fixed by adding `--env-file=../../.env` to `apps/api`'s `dev` script (Node's native flag, not a new dependency) — `start` (production) is deliberately left untouched, since production must get real env vars from its deployment platform, never a local file.
- Two Playwright test-infrastructure issues, not app bugs: a stale `next start` process from an earlier session run was still squatting port 3000 with an outdated build, causing `reuseExistingServer` to silently test against old code (fixed by killing it); and a genuine test-precision bug where `getByText('₹120.00')` matched five different on-page elements showing that amount simultaneously (fixed by walking from the unique "Subtotal" label to its adjacent value span instead of searching the whole page).
- No Docker in this sandbox — standing limitation, unchanged from every prior phase; the pricing engine and cart validation are proven via the in-memory-Prisma-backed suite and the Playwright mock server, not a live database.

**BLOCKED ON**
Nothing technically. Procedurally: paused, awaiting the user's explicit go-ahead before starting Phase 9, per their standing instruction.

**NEXT**
Phase 9 (Orders, checkout, payments) — the highest-risk phase in the project — once authorized.
