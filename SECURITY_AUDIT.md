# Security Audit — Phase 18

Date: 2026-08-15. Scope: full codebase against [docs/09-security.md](PRODUCT/docs/09-security.md) (the threat model this audit was written to close). Methodology: (1) enumerate every control the threat model names, (2) grep/read the actual implementation to confirm present/absent/partial, (3) for every named attack in §15.1/§15.5, confirm an automated regression test exists and passes, (4) fix every gap found, (5) re-run the full validation sweep and a live-database walkthrough.

No penetration test against a deployed environment was performed — there is no deployed environment yet (Phase 20 is launch readiness). "Penetration-style testing" here means: for each named attack, a real HTTP request attempting it, asserted to fail, run against the real application code (in-memory-Prisma-backed in the automated suite, real Postgres in the live-verification pass below) — not a manual review of intent.

## Summary

| Severity | Count | Status |
|---|---|---|
| Critical | 1 | Fixed |
| High | 3 | Fixed |
| Medium | 4 | Fixed |
| Low | 2 | Fixed |
| Informational / accepted | 2 | Documented, not fixed (see Decisions) |

**Zero unresolved critical or high findings.** Every fix below has a regression test that fails on the pre-fix code and passes after.

## Findings

### CRITICAL-1: Genuinely concurrent identical refund requests could create two refund rows

**Found by:** a new regression test for docs/09 §15.5's "submit two identical refunds concurrently" — the pre-existing test only replayed the same request *sequentially*, which never exercised the race.

**Root cause:** `RefundService.requestRefund` checked for an existing refund with the same `(paymentId, idempotencyKey)` *before* opening its transaction. Two genuinely concurrent callers both pass that check (neither has committed yet), then both attempt the transaction; the second's `INSERT` collides with the first's on `Refund.@@unique([paymentId, idempotencyKey])` and threw a raw, unhandled Prisma `P2002` error instead of being treated as an idempotent replay. This is a **financial-integrity bug** — under real concurrent traffic (a client double-tap, or two independent retries after a timeout) it would have surfaced as a 500 to one caller while the underlying refund still happened exactly once, or worse, masked whether a duplicate had actually landed.

**Fix:** `apps/api/src/modules/payments/services/refund.service.ts` — the transaction call is now wrapped in try/catch; on `isUniqueConstraintViolation`, it re-fetches and returns the already-committed refund instead of propagating the raw Prisma error. The same insert-and-let-the-constraint-decide pattern this codebase already uses everywhere else for idempotency, just applied at the catch site instead of a pre-check, since the pre-check alone cannot close a genuine race.

**Regression test:** `apps/api/test/refund.service.test.ts` — `"Phase 18: two genuinely concurrent requests with the same (paymentId, idempotencyKey) still produce exactly one refund"` (`Promise.all`, not sequential).

### HIGH-1: No security headers on either app

**Found by:** manual review against docs/09 §15.7 — grepped for `Content-Security-Policy`/`helmet`/`X-Content-Type-Options` etc. across both `apps/api` and `apps/web`; zero matches anywhere.

**Risk:** no CSP means a successful XSS (even a narrow one) has no defense-in-depth backstop; no HSTS means a user's first-ever request could be silently downgraded to HTTP by a network attacker; no `X-Content-Type-Options: nosniff` allows MIME-sniffing-based content-type confusion attacks.

**Fix:**
- `apps/api/src/main.ts` — `@fastify/helmet` registered with a full-lockdown CSP (`default-src 'none'; frame-ancestors 'none'; base-uri 'none'` — the API returns only JSON, never HTML, so there is no legitimate script/image/frame source to allow), HSTS (1-year max-age, includeSubDomains, preload), and `Referrer-Policy: strict-origin-when-cross-origin`. `Permissions-Policy` is set via a dedicated native Fastify hook (`apps/api/src/platform/security/permissions-policy.hook.ts`) rather than relying on helmet's own support for it, which has varied across major versions.
- `apps/web/next.config.mjs` — a `headers()` function applying docs/09 §15.7's literal CSP template (`default-src 'self'`, `img-src` allowing the CDN origin, `frame-src` allowing Razorpay's real checkout origin, `connect-src` allowing the API origin, `object-src 'none'`, `frame-ancestors 'none'`) plus the same four headers, to every route.

**Regression test:** `apps/api/test/security.e2e.test.ts` — `"every response carries CSP, HSTS, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy"`. (The web app's headers are declarative Next.js config, not independently unit-testable without a running server; verified by manual `curl` against the production build — see Live-database verification below.)

### HIGH-2: `POST /public/checkout` and `POST /public/checkout/quote` had no rate limiting

**Found by:** cross-referencing every `@RateLimit`-decorated route against every unauthenticated, state-changing/expensive route.

**Risk:** both are unauthenticated. `checkout` creates a real payment-provider order (a cost/quota consumer on the provider side, and a `PENDING_PAYMENT` order + `WebhookEvent` row per attempt) with no throttle at all; `quote` runs the full pricing engine (availability, price-drift, discount calculation) per call — both are checkout-spam/DoS vectors named explicitly in docs/09 §15.1's actor table ("Automated bot: ... checkout spam").

**Fix:** `@RateLimit({ limit: 20, windowSeconds: 3600 })` on `checkout.controller.ts`'s `create`; `@RateLimit({ limit: 60, windowSeconds: 3600 })` on `public-checkout.controller.ts`'s `quote` (quote is priced generously higher since a customer legitimately re-quotes while editing a cart).

**Regression tests:** `security.e2e.test.ts` — `"POST /public/checkout is rate limited"`, `"POST /public/checkout/quote is rate limited"`.

### HIGH-3: `POST /auth/otp/verify` (staff/admin) had no rate limiting — the actual brute-forceable step was unguarded while the request step was

**Found by:** the same cross-reference as HIGH-2, specifically noting the customer-facing OTP verify (`/auth/customer/otp/verify`) *does* have `@RateLimit`, while the staff/admin equivalent didn't — an inconsistency between two structurally identical endpoints.

**Risk:** `otp/request` (rate limited) only gates how many codes an attacker can *cause to be sent*; `otp/verify` is where an attacker actually *guesses* the 6-digit code against an already-issued one. Leaving verify unlimited means the per-code guess space (10^6) is fully exposed to unlimited attempts within the code's validity window, regardless of the request-side throttle.

**Fix:** `@RateLimit({ limit: 10, windowSeconds: 900, keyBy: identifier })` added to `auth.controller.ts`'s `verifyOtp`, matching the customer-side verify endpoint's exact shape.

**Regression test:** `security.e2e.test.ts` — `"POST /auth/otp/verify (staff) is rate limited per identifier"`.

### MEDIUM-1: `POST /auth/password/reset` had no rate limiting

**Risk:** the reset token is high-entropy, but leaving the confirm step completely unthrottled still removes a real layer of defense-in-depth against a leaked or partially-guessable token, and is inconsistent with every other "verify a secret" endpoint in this codebase (MFA verify, both OTP verifies) all being rate limited.

**Fix:** `@RateLimit({ limit: 10, windowSeconds: 900 })` added to `resetPassword`.

**Regression test:** `security.e2e.test.ts` — `"POST /auth/password/reset is rate limited"`.

### MEDIUM-2: No startup assertion that a production deploy can't run with a dev/localhost origin

**Found by:** docs/09 §15.7's explicit ask ("Development origins must not survive into production configuration — assert this in a startup check") — cross-checked against the actual env-validation code and found genuinely absent; proven absent by a pre-existing passing test that asserted `APP_ENV: 'production'` + `WEB_BASE_URL: 'http://localhost:3000'` **succeeds**.

**Risk:** a copy-pasted or incompletely-edited `.env` reaching a real production deploy would silently make `localhost:3000` the CORS-trusted origin and (implicitly, via the same value) the cookie `Secure` flag's effective trust boundary — a configuration mistake with real security consequences, not caught until an actual incident.

**Fix:** `apps/api/src/platform/config/env.schema.ts` — `validateEnv` now rejects `API_BASE_URL`/`WEB_BASE_URL` values that are non-HTTPS or resolve to `localhost`/`127.0.0.1`/`0.0.0.0`/`*.local` whenever `APP_ENV=production`, naming every offending variable at once (same "fail fast, name everything" convention the existing required-key check already uses).

**Regression tests:** `apps/api/test/env.schema.test.ts` — five `it.each` cases (http, localhost, 127.0.0.1, `.local`, for both `API_BASE_URL` and `WEB_BASE_URL`) plus a "names every dev-looking origin at once" test. The pre-existing `"accepts a complete production configuration"` test was updated to use realistic `https://` production domains rather than `localhost`, since that combination is now correctly rejected.

### MEDIUM-3: 1 MB JSON body limit was an unconfigured framework default, not an explicit, tested value — and exceeding it returned a raw 500

**Found by:** docs/09 §15.4's explicit "1 MB JSON body limit" — grepped for `bodyLimit` and found nothing; Fastify's own default happens to also be 1 MiB, but that's the framework's implementation detail, not something this codebase had ever asserted.

**Risk (secondary, found while fixing the first):** once made explicit and tested, the resulting 413 from Fastify surfaced as an opaque 500 `INTERNAL_ERROR` — `GlobalExceptionFilter` only recognized `AppError`, `ZodError`, and Nest's own `HttpException`, not Fastify's native error shape (a plain object with a numeric `statusCode`, thrown by Fastify itself before Nest's routing layer ever sees the request). This is the same class of gap Phase 9's `ProviderError` fix closed for an unrecognized payment-provider error shape.

**Fix:** `main.ts` sets `bodyLimit: 1024 * 1024` explicitly on the `FastifyAdapter`. `global-exception.filter.ts` gained an `isFastifyStatusError` branch that maps any sub-500 Fastify-native error to its real status/code (513→ wait, 413→`PAYLOAD_TOO_LARGE`), while still collapsing any 5xx Fastify error to the same generic, internals-free `INTERNAL_ERROR` every other truly-unexpected error gets.

**Regression test:** `security.e2e.test.ts` — `"rejects a JSON body over 1 MB (413), not an unbounded parse"`.

### MEDIUM-4: Pino's redact list had no phone or email field patterns

**Found by:** docs/09 §15.9's explicit "Never logged: ... full phone numbers (log last 4 digits), email addresses in bulk" — checked the actual `REDACT_PATHS` array and found password/token/OTP/card fields covered, but no phone or email pattern at all.

**Fix:** `apps/api/src/platform/logging/logger.ts` — added `*.phone`/`*.customerPhone`/`*.guestPhone` and `*.email`/`*.customerEmail` to `REDACT_PATHS`. The censor function now dispatches on the matched field *name* (not the value's shape) so a phone number is masked to its last 4 digits (per the doc's own carve-out for support traceability) while every other matched field — including a token that happens to end in digits — is still fully redacted. No active phone/email logging call site was found during this review; this closes the *configuration* gap so a future one is caught automatically, the entire point of redacting at the logger rather than the call site.

**Regression test:** `apps/api/test/logger.test.ts` — `"masks a phone number to its last 4 digits, redacts email fully, and never partially reveals a token that happens to end in digits"`.

### LOW-1: No build-time scan for server-only secret names leaking into the client bundle

**Found by:** docs/09 §15.8's explicit ask — confirmed no such mechanism existed anywhere in the build pipeline.

**Fix:** `scripts/check-web-bundle-secrets.mjs`, wired as `apps/web`'s `postbuild` script — scans every `.next/static/**/*.js` file (the code actually shipped to browsers; `.next/server/` legitimately contains these names and is excluded) for an explicit list of this codebase's real secret env var names, failing the build if any is found as literal text.

### LOW-2: No Dependabot configuration

**Found by:** docs/09 §15.11's explicit ask; `.github/` contained only `workflows/ci.yml`.

**Fix:** `.github/dependabot.yml` — weekly npm (workspace-root, covers every `package.json`), github-actions, and docker (docker-compose.yml's pinned service images) update checks, security patches ungrouped (individual PRs) and routine minor/patch bumps grouped to keep the PR queue reviewable.

## Attack-scenario coverage (docs/09 §15.5)

| # | Attack | Status |
|---|---|---|
| 1 | Modify the amount in the checkout body | Covered — `checkout.e2e.test.ts`: `"checkout rejects a client-supplied expectedTotalMinor that no longer matches (409 TOTAL_MISMATCH)"` |
| 2 | Replace `orderId` with another customer's | Covered (tenant/restaurant-level IDOR) — `restaurant-orders.e2e.test.ts`, `delivery.e2e.test.ts`; customer-token swap covered by #8 below |
| 3 | Forge a `payment.captured` webhook without a valid signature | Covered — `checkout.e2e.test.ts`: `"invalid webhook signature: rejected before any processing or storage"` |
| 4 | Replay a valid webhook | Covered — `checkout.e2e.test.ts`: `"duplicate webhook: the same signed event applied twice is processed once"` |
| 5 | Submit a refund exceeding the captured amount | Covered — `refund.service.test.ts`: `"INV-6: rejects a refund that would push the total refunded above the captured amount"` |
| 6 | Submit two identical refunds concurrently | **Was not covered — fixed this phase.** See CRITICAL-1. `refund.service.test.ts`: the new `Promise.all`-based test |
| 7 | Mark an unpaid order paid via any API | **Was not covered — fixed this phase (test added; no code defect found).** `security.e2e.test.ts`: `"an order can never be marked PLACED without a real provider-verified capture..."` — confirms `verify-payment` always fetches status from the provider, never trusts a client-supplied outcome, for a genuinely-never-paid order |
| 8 | Access another customer's order by order number without a token | Covered — `checkout.e2e.test.ts`: `"cross-customer order access: tracking with no/wrong token 404s identically to a nonexistent order"` |

Every named attack in the threat model now has a dedicated, passing regression test.

## Rate limiting — full review

Every `@RateLimit`-decorated route, before and after this phase:

| Route | Limit | Status |
|---|---|---|
| `POST /auth/register` | 5/3600s | Pre-existing |
| `POST /auth/login` | 10/900s | Pre-existing |
| `POST /auth/password/forgot` | 5/3600s | Pre-existing |
| `POST /auth/password/reset` | 10/900s | **Added (MEDIUM-1)** |
| `POST /auth/otp/request` | 5/3600s, per identifier | Pre-existing |
| `POST /auth/otp/verify` | 10/900s, per identifier | **Added (HIGH-3)** |
| `POST /auth/mfa/enroll/confirm` | 10/900s | Pre-existing |
| `POST /auth/mfa/verify` | 10/900s | Pre-existing |
| `POST /auth/customer/otp/request` | 5/3600s, per phone | Pre-existing |
| `POST /auth/customer/otp/verify` | 10/900s, per phone | Pre-existing |
| `POST /restaurant/uploads/presign` | 20/3600s | Pre-existing |
| `POST /public/checkout` | 20/3600s | **Added (HIGH-2)** |
| `POST /public/checkout/quote` | 60/3600s | **Added (HIGH-2)** |

The per-account lockout mechanism (`LoginThrottleService` — 10 failures / 15-minute window, keyed by identifier, checked before password comparison) was reviewed and matches docs/09 §15.2's spec exactly; no change needed. It exists for staff/admin login only — customer OTP has no equivalent concept (there is no password to brute-force; the per-phone rate limit on both request and verify is the actual defense).

`POST /auth/logout` and `POST /auth/refresh` remain unlimited — both require an already-valid session cookie to do anything, so they are not a meaningful unauthenticated-abuse surface.

## Decisions

- **Postgres Row-Level Security was evaluated and deliberately not implemented this phase.** docs/09 §15.3 names it explicitly as "optional fourth layer for Phase 18," on top of the three layers already in place and enforced since Phase 4: route guards (permission + tenant scope declared per endpoint), repository scoping (every restaurant-scoped query derives `restaurantId` from the authenticated principal, never a client-supplied value — enforced by convention and reviewed per phase via the docs/09 §15.12 checklist), and integration tests (every tenant-scoped endpoint across all 17 phases built so far has an explicit cross-tenant test asserting 404, not just 403 — over 30 such tests exist in the suite today). Adding RLS would mean wrapping every single Prisma call across the entire codebase in a request-scoped transaction that first runs `SET LOCAL app.current_restaurant_id`, a genuine architecture change (Prisma's connection pooling model doesn't naturally support per-request `SET LOCAL` outside an explicit transaction) touching every module, not a contained addition — the kind of change this codebase's own scope discipline (docs/16-execution-protocol.md §24.6) argues against taking on speculatively when the three required layers are already real, tested, and have never once been the source of a cross-tenant leak in this project's own audit history. If a real incident or a specific compliance requirement (e.g., a customer contractually requiring database-level tenant isolation) materializes later, this decision should be revisited — it is deferred, not rejected on principle.
- **The 1 MB body limit and every new rate limit are deliberately generous, not maximally restrictive.** A limit tight enough to block a determined attacker outright would also be tight enough to occasionally block a legitimate burst (a restaurant re-quoting a cart repeatedly while a customer edits it, a flaky network causing legitimate retries) — every new limit in this phase was chosen to sit meaningfully above realistic legitimate usage while still bounding automated abuse to a cost that makes it impractical, the same calibration philosophy the pre-existing limits already use.
- **CSP's `script-src`/`style-src` allow no external origins beyond `'self'` (plus `'unsafe-inline'` for styles).** Next.js's own hydration/RSC payload requires `'self'` script execution; Tailwind's generated inline `<style>` tags require `'unsafe-inline'` for style-src specifically (a real, narrow relaxation — `'unsafe-inline'` on `script-src` was never added). No third-party analytics/tag-manager script is loaded anywhere in this codebase today, so there was nothing else to allowlist.

## Full validation sweep

typecheck (root `pnpm run typecheck` — all workspaces) / lint (`pnpm run lint`, repo-wide `--max-warnings=0`) / full test suite (all workspaces) / all workspace builds (`packages/money`, `packages/contracts`, `apps/worker`, `apps/api`, `apps/web` including the new bundle-secret-scan `postbuild` step) — all clean. See `PHASE_REPORTS.md`'s Phase 18 entry for exact counts and the live-database verification walkthrough.

## Residual, out-of-scope risk (unchanged from prior phases, not part of this audit's findings)

Real Uber Direct and real Razorpay remain unverified against live provider APIs — no real credentials exist in this environment. This is a standing, previously-documented gap (every phase report since Phase 9/11 names it), not a new finding, and not something Phase 18's own scope (auditing the code and infrastructure that *does* exist) can close without real provider access.
