# 21. Acceptance Criteria

Testable conditions per phase. "Feature works" is not acceptance. Every criterion below is observable — by a test, an HTTP response, or a database query.

---

## Phase 1 — Foundation

- [ ] `git clone` → `pnpm install` → `docker compose up -d` → `pnpm db:migrate` → `pnpm dev` produces a running stack using only the README
- [ ] `GET /health` returns 200 while the database is stopped (liveness is independent of dependencies)
- [ ] `GET /ready` returns 503 while the database is stopped and 200 when it is up
- [ ] A malformed request returns the standard error envelope with `code`, `message`, `requestId`
- [ ] Starting with a required production variable missing produces a clear startup failure naming the variable, not a runtime crash later
- [ ] `toMinor("250.50")` returns `25050n`; passing a float to any money function is a type error
- [ ] Every log line is JSON and carries a correlation ID
- [ ] CI fails the build on a lint error, a type error, or a failing test

## Phase 2 — Schema and tenancy

- [ ] Migrations apply cleanly to an empty database and are re-runnable without error
- [ ] Seed creates two restaurants with distinct owners and staff
- [ ] Inserting a duplicate slug fails at the database level
- [ ] Inserting a duplicate `(user_id, restaurant_id)` staff row fails at the database level
- [ ] `UPDATE` or `DELETE` on `audit_logs` as the application role is rejected
- [ ] A tenant-scoped repository call without a `restaurantId` fails to compile

## Phase 3 — Authentication

- [ ] Register → verify → login → access protected route → refresh → logout → protected route now 401
- [ ] Login with a wrong password and login with a non-existent account return the **same** status, body, and comparable timing
- [ ] Password reset token is single-use and revokes all existing sessions
- [ ] Presenting a refresh token that was already rotated revokes the entire session family and logs a security event
- [ ] 11 login attempts within 15 minutes from one IP returns 429 with `Retry-After`
- [ ] `GET /auth/me` response contains no `password_hash`, token, or secret field (assert against a field allowlist)
- [ ] A DISABLED user cannot authenticate or use an existing valid access token

## Phase 4 — Authorization

- [ ] Every entry in the permission matrix is asserted by a test
- [ ] Restaurant A's owner requesting any Restaurant B resource receives **404** and a logged tenant-isolation event
- [ ] Sending `X-Restaurant-Id` for a restaurant the user does not belong to returns 403
- [ ] A `role` field in any client request body is stripped and never persisted
- [ ] A staff member disabled during an active session loses access on the next request
- [ ] Restaurant users receive 403 on every `/admin/*` route

## Phase 5 — Onboarding

- [ ] A new owner completes onboarding and reaches the dashboard; progress resumes correctly after abandoning midway
- [ ] `POST /restaurants` with `ownerId` set to another user creates the restaurant owned by the **authenticated** user
- [ ] A reserved slug (`admin`, `api`, `r`) is rejected with a clear message
- [ ] An invitation cannot be accepted twice, or after expiry, or after revocation
- [ ] The last active OWNER cannot be demoted or removed — returns 409 `LAST_OWNER`
- [ ] Uploading a `.svg`, a 10 MB file, or a `.exe` renamed to `.jpg` is rejected
- [ ] Onboarding completion is determined by the backend; clearing browser storage does not change it

## Phase 6 — Menu

- [ ] Categories and items create, update, reorder, and archive correctly and persist across refresh
- [ ] Archiving an item referenced by a historical order succeeds and the order still renders correctly
- [ ] Price `0`, negative, and `"abc"` are all rejected server-side
- [ ] Marking an item unavailable is reflected on the public menu within one cache TTL
- [ ] A failed availability toggle does not leave the UI showing an unsaved state
- [ ] Reordering is atomic — a partial failure leaves the previous order intact
- [ ] Restaurant A cannot read or modify Restaurant B's menu (404)

## Phase 7 — Public page

- [ ] `/r/<valid-slug>` server-renders with correct title, description, and Open Graph tags
- [ ] `/r/<unknown-slug>` returns 404
- [ ] A SUSPENDED restaurant's page does not expose its menu
- [ ] The public response contains **only** allowlisted fields — no staff, settings, internal IDs, or financial data
- [ ] A restaurant open 22:00–02:00 shows OPEN at 23:30 and at 01:30, CLOSED at 03:00 — evaluated in the restaurant's timezone
- [ ] A special-hours entry overrides weekly hours for that date
- [ ] The cart survives a page refresh and rejects items from a different restaurant
- [ ] An unavailable item cannot be added, including via a direct API call
- [ ] The full browse flow is completable by keyboard alone
- [ ] The page is usable at 375 px with no horizontal scroll

## Phase 8 — Pricing

- [ ] Every case in the pricing test suite passes, including all rounding boundaries
- [ ] The same input produces byte-identical output across 1,000 runs
- [ ] A discount larger than the order total clamps to a payable total of exactly 0, never negative
- [ ] No float appears anywhere in the pricing trace (assert on types)
- [ ] The quote total exactly equals the amount subsequently charged
- [ ] Validation reports each cart problem individually with a specific code

## Phase 9 — Orders and payments

- [ ] A sandbox payment produces exactly one order with correct server-computed totals
- [ ] Sending `expectedTotalMinor` that disagrees with the server returns 409 and creates no order
- [ ] Sending a manipulated item price in the checkout body has **no effect** on the charged amount
- [ ] Clicking pay twice rapidly produces one order and one payment attempt
- [ ] Two concurrent checkouts with the same idempotency key produce one order; the second returns the first's response
- [ ] A duplicate webhook produces exactly one state transition and one notification
- [ ] A webhook with an invalid signature returns 401, is not processed, and raises a security event
- [ ] A webhook reporting an amount different from the order total does **not** mark the order paid and creates a CRITICAL reconciliation issue
- [ ] `DELIVERED → PREPARING` returns 409 through every available path including admin
- [ ] Refreshing the payment page recovers existing order state rather than restarting payment
- [ ] A refund exceeding the captured amount is rejected
- [ ] Two concurrent refunds cannot together exceed the captured amount
- [ ] Customer A requesting Customer B's order by order number receives 404
- [ ] Every state transition has a corresponding immutable history row

## Phase 10 — Order management

- [ ] A paid order appears in the dashboard without manual refresh
- [ ] With the dashboard closed during payment, the order is present on next load
- [ ] Two staff accepting simultaneously: one transition occurs, no duplicated side effects
- [ ] Double rejection creates exactly one refund
- [ ] Rejecting a paid order initiates a full refund automatically
- [ ] SSE reconnection replays missed events; with SSE unavailable, polling still surfaces new orders
- [ ] The restaurant sees only its own orders, with server-side pagination
- [ ] Restaurant staff cannot alter any historical price or payment field

## Phase 11 — Delivery

- [ ] Marking ready dispatches exactly one delivery
- [ ] Marking ready twice results in exactly one delivery row
- [ ] A provider timeout followed by a retry does not create a second delivery
- [ ] Provider rejection leaves the order **not** marked out for delivery and alerts restaurant and admin
- [ ] A duplicate delivery webhook produces one transition
- [ ] `DELIVERED` arriving before `PICKED_UP` is handled without error or state corruption
- [ ] Customer tracking reflects real delivery state
- [ ] Provider credentials appear in no API response and no log line
- [ ] With `DELIVERY_PROVIDER=mock`, the system reports delivery as **not production-enabled**

## Phase 12 — Notifications

- [ ] Each order state change generates the specified notifications
- [ ] A duplicated domain event produces one notification per recipient per channel
- [ ] A transactional preference cannot be disabled via the API
- [ ] A marketing notification is not sent without recorded consent
- [ ] With the SMS provider returning 500, the order still completes and the notification retries then dead-letters visibly
- [ ] Unread count is correct after read, read-all, and new notifications
- [ ] Customer A cannot read Customer B's notifications (404)

## Phase 13 — Admin

- [ ] Non-admin principals receive 403 on every admin route
- [ ] Suspending a restaurant blocks new orders while in-flight orders remain fulfillable
- [ ] Every admin action appears in the audit log with actor, target, reason, and timestamp
- [ ] No API path exists to create, edit, or delete an audit record
- [ ] Admin lists paginate server-side and remain responsive with 100,000 orders seeded
- [ ] Payment views mask provider references and expose no secrets
- [ ] Admin MFA is enforced at the API, not only in the UI

## Phase 14 — Promotions

- [ ] A coupon with `usage_limit_total = 1` under 10 concurrent claims yields exactly 1 redemption
- [ ] A per-customer limit of 1 cannot be exceeded by the same customer
- [ ] Failed payment releases the reservation and the coupon becomes usable again
- [ ] An expired or inactive coupon is rejected with an anti-enumeration-safe message
- [ ] A percentage discount respects its maximum cap
- [ ] A fixed discount never drives the total below zero
- [ ] A restaurant cannot create or modify platform-wide promotions
- [ ] Discount values sent by the client are ignored entirely

## Phase 15 — Reviews

- [ ] Only a customer with a DELIVERED order for that restaurant can review it
- [ ] A second review for the same order is rejected, including under concurrency
- [ ] A `<script>` payload in review text is stored safely and rendered as inert text
- [ ] A restaurant cannot edit, hide, or delete a customer review
- [ ] The rating aggregate exactly matches a recount of published reviews
- [ ] Public reviews expose no phone, email, or address
- [ ] Ratings outside 1–5 and non-integers are rejected

## Phase 16 — Loyalty and referrals

- [ ] Points are granted on DELIVERED and not before
- [ ] A duplicated `ORDER_DELIVERED` event grants points exactly once
- [ ] Two concurrent redemptions of a full balance: one succeeds, one is rejected
- [ ] A refund claws back points proportionally
- [ ] `SUM(loyalty_ledger.points)` equals `loyalty_accounts.balance_points` for every customer
- [ ] An admin adjustment creates a ledger row; no code path mutates the balance directly
- [ ] Self-referral is rejected by the database constraint
- [ ] A customer cannot acquire a second referrer
- [ ] A duplicated qualification event issues one reward
- [ ] Referrers see status only — no personal data about referred customers

## Phase 17 — Support and analytics

- [ ] A customer can open a case only against their own order
- [ ] INTERNAL messages are absent from every customer- and restaurant-facing response
- [ ] Attachments are private and served only via short-lived signed URLs
- [ ] Daily rollups reconcile exactly with the underlying orders and payments
- [ ] Daily boundaries respect the restaurant's timezone
- [ ] Analytics failure does not affect order or payment processing
- [ ] Dashboards load within targets on realistic data volumes

## Phase 18 — Security

- [ ] Every threat in the model has been tested
- [ ] Zero unresolved critical or high findings
- [ ] Every fixed vulnerability has a regression test
- [ ] Secret scan is clean
- [ ] `npm audit` reports no high or critical issues, or each is documented and accepted with rationale
- [ ] Security headers verified on production-equivalent responses
- [ ] `SECURITY_AUDIT.md` is complete and does not claim "100% secure"

## Phase 19 — Reliability

- [ ] A restore drill has been performed and passed; date and duration recorded
- [ ] Application starts against the restored database and passes smoke tests
- [ ] Graceful shutdown drains requests and jobs without loss
- [ ] Every data-integrity assertion returns zero rows
- [ ] Load test results recorded with measured — not estimated — numbers
- [ ] Every alert has a runbook

## Phase 20 — Launch

- [ ] Production deployed with migrations applied and health checks green
- [ ] Smoke tests pass against production
- [ ] Monitoring and alerts verified as firing
- [ ] All external dependencies reported with accurate status
- [ ] `LAUNCH_REPORT.md` states a status justified by evidence, and names every blocker

---

## Definition of Done — per change

Applies to every commit after Phase 1:

- [ ] Typecheck, lint, format pass
- [ ] New logic has tests; new endpoints have authorization and isolation tests
- [ ] Full regression suite passes
- [ ] Both applications build
- [ ] Documentation updated where behaviour changed
- [ ] No secrets, debug code, console logs, or commented-out blocks in the diff
- [ ] Money paths carry no floating-point arithmetic
- [ ] New financial operations are idempotent by database constraint
- [ ] New state changes write audit records
- [ ] The diff contains only changes relevant to the stated task
