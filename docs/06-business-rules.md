# 10. Business Rules

Every rule extracted from the 30 requirement prompts, numbered for reference from code comments, tests, and commit messages. A test that asserts a rule should name it (`BR-42`).

Rules marked **[PD]** depend on an unresolved product decision — see [15-ambiguities-and-risks.md](15-ambiguities-and-risks.md). Implement the recommended default and keep it behind configuration.

---

## Money and pricing (BR-1 … BR-15)

| #     | Rule                                                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| BR-1  | All monetary values are integer minor units (paise). Floating-point arithmetic on money is forbidden anywhere in the stack, including the frontend. |
| BR-2  | The server computes every payable amount from database state. A client-supplied price, fee, discount, or total is never authoritative.              |
| BR-3  | Order total = items subtotal + packaging fee + delivery fee + platform fee + tax − discounts − loyalty discount. Enforced by a database CHECK.      |
| BR-4  | Line total = unit price snapshot × quantity, exactly. Enforced by CHECK.                                                                            |
| BR-5  | Percentage calculations round half-up to the nearest paise, applied once, at the point of calculation. Intermediate sums are never re-rounded.      |
| BR-6  | `payable_total_minor >= 0` always. Discounts are clamped so the total can never go negative.                                                        |
| BR-7  | Combined discounts (promotion + loyalty) may not exceed the discountable base.                                                                      |
| BR-8  | Currency is INR for v1. Every monetary column carries an explicit currency; mixed-currency arithmetic is rejected.                                  |
| BR-9  | Order pricing is snapshotted at creation. Later changes to menu prices, fees, taxes, or promotions never alter an existing order.                   |
| BR-10 | The full pricing trace is persisted in `pricing_breakdown` so any historical total can be re-explained exactly.                                     |
| BR-11 | The restaurant sees a per-order breakdown: order value, payment fee, delivery cost, platform deduction, net payout.                                 |
| BR-12 | The customer sees a complete breakdown before payment: subtotal, delivery, packaging, taxes, discounts, total.                                      |
| BR-13 | Delivery fee charged to the customer and delivery cost paid to the provider are recorded as **separate values**. They are not assumed equal.        |
| BR-14 | Platform fee is configurable and may be zero during the pilot. Zero must render as absent, not as a confusing "₹0 platform fee" line. **[PD]**      |
| BR-15 | Tax treatment (GST rate, inclusive vs exclusive, per-item vs order-level) is configurable per restaurant. **[PD — requires tax advice]**            |

## Cart and checkout (BR-16 … BR-35)

| #     | Rule                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BR-16 | A cart belongs to exactly one restaurant.                                                                                                              |
| BR-17 | Adding an item from a different restaurant prompts the customer to clear the cart. The server never silently merges or discards.                       |
| BR-18 | Cart contents are re-validated server-side at checkout against live data.                                                                              |
| BR-19 | An unavailable, archived, or deleted item blocks checkout with an explicit per-item error.                                                             |
| BR-20 | A price change between cart and checkout blocks checkout with a `PRICE_CHANGED` error listing old and new prices. The customer must explicitly accept. |
| BR-21 | Checkout is blocked if the restaurant is not accepting orders at that moment.                                                                          |
| BR-22 | Minimum order value, when configured, is checked against the **items subtotal** before discounts.                                                      |
| BR-23 | Per-item quantity is capped (default 99) and validated server-side.                                                                                    |
| BR-24 | Guest checkout is supported. Registration is never forced to place an order.                                                                           |
| BR-25 | Required customer details: name, phone, delivery address. Email is optional.                                                                           |
| BR-26 | Phone numbers are validated and normalised to E.164.                                                                                                   |
| BR-27 | The delivery address is snapshotted onto the order. Later edits to the saved address do not change past orders.                                        |
| BR-28 | Checkout requires an `Idempotency-Key`. A replay returns the original order.                                                                           |
| BR-29 | Two concurrent identical checkouts produce exactly one order — enforced by a unique constraint, not an application check.                              |
| BR-30 | Repeated payment attempts reuse the **same order**; they never create a second one.                                                                    |
| BR-31 | A cart expires after 24 hours of inactivity.                                                                                                           |
| BR-32 | Delivery-area validation, where configured, runs server-side before order creation.                                                                    |
| BR-33 | An unpaid order expires after `ORDER_PAYMENT_TTL_MINUTES` (default 30) and releases all reservations. Records are retained.                            |
| BR-34 | Order numbers are unique, human-readable, and not sequentially guessable across customers.                                                             |
| BR-35 | Guest order access requires a signed token; the order number alone is insufficient.                                                                    |

## Payments (BR-36 … BR-50)

| #     | Rule                                                                                                                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BR-36 | An order becomes PLACED only after provider-verified payment confirmation.                                                                                            |
| BR-37 | A frontend success callback triggers server-side verification. It never sets payment state directly.                                                                  |
| BR-38 | Every webhook is signature-verified against the **raw** request body before parsing.                                                                                  |
| BR-39 | Webhooks are persisted before processing and deduplicated by `(provider, provider_event_id)`.                                                                         |
| BR-40 | Duplicate webhooks produce exactly one business effect.                                                                                                               |
| BR-41 | Out-of-order webhooks never regress payment state; stale events are ignored and logged.                                                                               |
| BR-42 | If the provider amount differs from the expected order total, the payment is **not** marked successful. A CRITICAL reconciliation issue is raised and an alert fires. |
| BR-43 | Currency mismatch is handled identically to amount mismatch.                                                                                                          |
| BR-44 | Card numbers, CVV, and PINs are never stored, logged, or transmitted through our systems.                                                                             |
| BR-45 | Provider credentials never reach the browser.                                                                                                                         |
| BR-46 | Payment failure leaves the order retryable within its TTL.                                                                                                            |
| BR-47 | A webhook arriving for an unknown order is stored, flagged for reconciliation, and returns 200 — never silently dropped.                                              |
| BR-48 | Payment records are immutable except through the payment state machine. No direct database writes to payment state exist in application code.                         |
| BR-49 | Refunded total may never exceed captured total. Enforced by CHECK plus row-locking on refund creation.                                                                |
| BR-50 | Refunds are idempotent by `(payment_id, idempotency_key)`.                                                                                                            |

## Orders and fulfilment (BR-51 … BR-65)

| #     | Rule                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------- |
| BR-51 | Order state changes flow exclusively through the order state transition service.                                    |
| BR-52 | Every transition writes an immutable status-history row with actor, timestamp, and reason.                          |
| BR-53 | Illegal transitions return 409 with the current state.                                                              |
| BR-54 | Re-requesting an already-applied transition returns 200 with current state (idempotent).                            |
| BR-55 | Concurrent conflicting transitions: exactly one succeeds; the other receives 409.                                   |
| BR-56 | Restaurant rejection of a paid order automatically initiates a **full refund**.                                     |
| BR-57 | Rejection requires a reason.                                                                                        |
| BR-58 | Restaurant staff cannot alter historical prices, payment amounts, or payment state.                                 |
| BR-59 | Restaurants see only their own orders.                                                                              |
| BR-60 | Delivery dispatch is triggered when the order reaches READY_FOR_PICKUP.                                             |
| BR-61 | Exactly one delivery per order — enforced by a unique constraint.                                                   |
| BR-62 | Marking ready twice creates one delivery and returns success both times.                                            |
| BR-63 | A delivery provider timeout is never treated as "not created". Reconcile before retrying.                           |
| BR-64 | Delivery failure does not automatically refund. It raises an operational issue for human decision. **[PD — AMB-8]** |
| BR-65 | Suspending a restaurant blocks new orders but never cancels, refunds, or strands in-flight orders.                  |

## Restaurant operations (BR-66 … BR-76)

| #     | Rule                                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| BR-66 | `isAcceptingOrders()` is the single authority on ordering availability, consumed by the public page, search, and checkout alike. |
| BR-67 | Availability precedence: platform status → closure period → special hours → operating hours → `ordering_enabled`.                |
| BR-68 | A platform-suspended restaurant cannot make itself orderable.                                                                    |
| BR-69 | Operating hours are evaluated in the restaurant's own timezone, never the server's.                                              |
| BR-70 | Overnight hours (close time ≤ open time) span midnight and must be handled explicitly.                                           |
| BR-71 | Special-date hours override weekly hours.                                                                                        |
| BR-72 | Item availability is authoritative on the backend; an unavailable item cannot be ordered regardless of client state.             |
| BR-73 | Menu items are archived, never hard-deleted.                                                                                     |
| BR-74 | Restaurant slugs are unique, normalised, and validated against a reserved list.                                                  |
| BR-75 | Changing a slug breaks existing shared links. The old slug redirects for 90 days. **[PD — AMB-5]**                               |
| BR-76 | Every restaurant retains at least one active OWNER at all times.                                                                 |

## Staff and access (BR-77 … BR-84)

| #     | Rule                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------- |
| BR-77 | Staff invitations are single-use, expiring (7 days), and revocable.                                     |
| BR-78 | Invitation tokens are stored hashed; the raw token exists only in the delivered link.                   |
| BR-79 | Disabling a staff member revokes their sessions for that restaurant immediately.                        |
| BR-80 | Role and restaurant membership are re-verified on every request, never trusted from token claims alone. |
| BR-81 | Staff cannot modify their own role.                                                                     |
| BR-82 | Restaurant roles never grant platform-admin capability by any path.                                     |
| BR-83 | Admin accounts require MFA.                                                                             |
| BR-84 | At least one active SUPER_ADMIN must always exist.                                                      |

## Promotions (BR-85 … BR-96)

| #     | Rule                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------ |
| BR-85 | Coupon validity is determined entirely server-side.                                                    |
| BR-86 | A coupon validated in the cart is **re-validated** at checkout.                                        |
| BR-87 | Usage limits are enforced with row-locking; counting then inserting is forbidden.                      |
| BR-88 | A coupon is **reserved** at checkout and confirmed only on payment capture.                            |
| BR-89 | Failed or expired payment releases the reservation, returning the coupon to circulation.               |
| BR-90 | Order cancellation after payment does **not** return coupon usage. **[PD — AMB-9]**                    |
| BR-91 | Percentage discounts respect the configured maximum discount cap.                                      |
| BR-92 | Fixed discounts may not exceed the eligible amount.                                                    |
| BR-93 | Promotions do not stack by default; the single best-value promotion applies. **[PD — AMB-10]**         |
| BR-94 | Loyalty redemption may combine with one promotion, applied after promotion discount. **[PD — AMB-10]** |
| BR-95 | Coupon validation responses do not reveal whether an unknown code exists (anti-enumeration).           |
| BR-96 | First-order eligibility is determined from delivered order history, never from a client claim.         |

## Loyalty (BR-97 … BR-107)

| #      | Rule                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BR-97  | The ledger is authoritative; the account balance is a derived cache reconciled on a schedule.                                                                |
| BR-98  | Points are earned when an order reaches **DELIVERED**, not at payment.                                                                                       |
| BR-99  | Earning is idempotent by `(type, reference_type, reference_id)` — an order can never award twice.                                                            |
| BR-100 | Points are earned on the items subtotal, excluding fees, taxes, and discounts. **[PD — AMB-11]**                                                             |
| BR-101 | Redemption locks the account row; concurrent redemptions cannot overdraw.                                                                                    |
| BR-102 | Redemption is reserved at checkout and confirmed on payment capture, mirroring coupons.                                                                      |
| BR-103 | A refunded order claws back its earned points proportionally to the refunded amount.                                                                         |
| BR-104 | Clawback may drive the balance negative; redemption is blocked while negative. This preserves ledger truth rather than silently forgiving. **[PD — AMB-12]** |
| BR-105 | Cancelled orders earn no points.                                                                                                                             |
| BR-106 | Admin adjustments write a ledger entry with actor and reason. Direct balance mutation does not exist.                                                        |
| BR-107 | Point expiry, if enabled, writes explicit EXPIRATION ledger entries — points are never silently deleted. **[PD]**                                            |

## Referrals (BR-108 … BR-116)

| #      | Rule                                                                                     |
| ------ | ---------------------------------------------------------------------------------------- |
| BR-108 | A customer may have at most one referrer, ever. Enforced by unique constraint.           |
| BR-109 | Self-referral is blocked by a database CHECK, not only by application logic.             |
| BR-110 | Attribution occurs at signup; the referral code is resolved server-side.                 |
| BR-111 | A referral qualifies only when the referred customer's first order reaches DELIVERED.    |
| BR-112 | Rewards are issued once per referral — enforced through the loyalty ledger's uniqueness. |
| BR-113 | Refund of the qualifying order invalidates the referral and claws back rewards.          |
| BR-114 | Referral reward failure never rolls back the qualifying order; it is retried.            |
| BR-115 | Referrers see referral status but no personal data about the referred customer.          |
| BR-116 | Referral codes are rate-limited against enumeration.                                     |

## Reviews (BR-117 … BR-124)

| #      | Rule                                                                                       |
| ------ | ------------------------------------------------------------------------------------------ |
| BR-117 | Only a customer with a DELIVERED order for that restaurant may review it.                  |
| BR-118 | One review per order, enforced by unique constraint.                                       |
| BR-119 | Rating is an integer 1–5, validated server-side.                                           |
| BR-120 | Review text is treated as untrusted input; stored escaped and never rendered as HTML.      |
| BR-121 | Restaurants cannot edit, hide, or delete customer reviews.                                 |
| BR-122 | Restaurants may post one public response per review.                                       |
| BR-123 | Rating aggregates include only PUBLISHED reviews and are reconcilable against source rows. |
| BR-124 | Public reviews display a minimal customer identity — never phone, email, or address.       |

## Notifications (BR-125 … BR-133)

| #      | Rule                                                                                          |
| ------ | --------------------------------------------------------------------------------------------- |
| BR-125 | Notification delivery is asynchronous and never blocks a transaction.                         |
| BR-126 | Notification failure never rolls back a committed order, payment, or refund.                  |
| BR-127 | Notifications are deduplicated by `(event, recipient, channel)`.                              |
| BR-128 | Transactional and security notifications cannot be disabled by preference.                    |
| BR-129 | Marketing notifications require explicit consent; account creation is not consent.            |
| BR-130 | Notifications never contain passwords, tokens, full payment details, or unnecessary PII.      |
| BR-131 | Failed notifications retry with backoff up to a cap, then dead-letter visibly.                |
| BR-132 | A notification is never sent before the underlying state change is committed.                 |
| BR-133 | Restaurants receive new-order alerts containing only the order reference and minimal context. |

## Support (BR-134 … BR-140)

| #      | Rule                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| BR-134 | Customers may only open cases against their own orders.                                                                       |
| BR-135 | Restaurants may only open and view cases for their own restaurant.                                                            |
| BR-136 | INTERNAL notes are never returned to customers or restaurants by any endpoint.                                                |
| BR-137 | Support agents cannot mutate payment, order, or loyalty state directly; they act only through the authorised domain services. |
| BR-138 | Refunds initiated through support require the `payments:refund` permission.                                                   |
| BR-139 | Every support action on a financial or order entity is audited.                                                               |
| BR-140 | Attachments are private, size- and type-validated, and served via short-lived signed URLs.                                    |

## Search and discovery (BR-141 … BR-146)

| #      | Rule                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------- |
| BR-141 | Search returns only publicly visible restaurants; suspended, draft, and pending restaurants are excluded. |
| BR-142 | "Open now" uses the same `isAcceptingOrders()` authority as the restaurant page.                          |
| BR-143 | Search never exposes private restaurant, staff, or customer data.                                         |
| BR-144 | Ranking is deterministic and documented; identical input and state produce identical order.               |
| BR-145 | Search results are advisory. Checkout revalidates everything regardless of what search returned.          |
| BR-146 | Cross-restaurant customer-facing discovery is feature-flagged off by default. **[PD — AMB-1]**            |

## Security, privacy, audit (BR-147 … BR-158)

| #      | Rule                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------ |
| BR-147 | Passwords are hashed with argon2id and never logged, returned, or stored reversibly.                   |
| BR-148 | Authorization derives from the authenticated principal, never from client-supplied identifiers.        |
| BR-149 | Cross-tenant access attempts return 404 and are logged as security events.                             |
| BR-150 | Unknown request fields are stripped at validation, preventing mass assignment.                         |
| BR-151 | Secrets never appear in source control, logs, URLs, analytics, error messages, or the frontend bundle. |
| BR-152 | Logs never contain passwords, tokens, card data, or unnecessary PII.                                   |
| BR-153 | Every privileged and state-changing action writes an audit record.                                     |
| BR-154 | Audit records are append-only; no update or delete path exists in application code or database grants. |
| BR-155 | Financial records are never deleted, including on account deletion — they are anonymised instead.      |
| BR-156 | Production error responses expose no stack traces, SQL, or internal paths.                             |
| BR-157 | Uploaded files are validated by size and content type; declared MIME is never trusted.                 |
| BR-158 | Analytics events contain no PII beyond internal identifiers.                                           |

## Restaurant approval fast-path (BR-159 … BR-164, Phase 21a)

| #      | Rule                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BR-159 | Submitting onboarding (initial or resubmission) sets `submittedAt` and notifies every admin holding `restaurant:approve` or `restaurant:reject`.                                                             |
| BR-160 | `decidedAt` and `rejectionReason` are set only when the decision resolves a PENDING_APPROVAL submission — reinstating a SUSPENDED restaurant is a different kind of decision and never touches either field. |
| BR-161 | Rejecting a restaurant requires a reason (1–500 characters) and notifies the restaurant with that reason.                                                                                                    |
| BR-162 | A rejected restaurant may resubmit through the same onboarding submission endpoint; resubmission clears the prior rejection reason.                                                                          |
| BR-163 | `restaurant:approve` and `restaurant:reject` are distinct permissions, even though held by the same admin roles today — matching `orders:accept`/`orders:reject`'s precedent.                                |
| BR-164 | Approval-lifecycle fields (`submittedAt`, `decidedAt`, `rejectionReason`) are internal moderation state, never exposed on the public/anonymous restaurant endpoint.                                          |

## Admin-assisted restaurant management (BR-165 … BR-173, Phase 22)

| #      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BR-165 | An admin-created restaurant starts in `DRAFT` status, identical to a self-serve restaurant — there is no separate "admin fast-track" status. An admin completing concierge setup submits it for approval through an admin-authorized equivalent of the owner's onboarding-submit action; the restaurant still requires a separate, explicit approval action before becoming `ACTIVE`. Phase 21's human-review gate is never bypassed for admin-created restaurants, even when the creating admin also approves it. |
| BR-166 | An admin-created restaurant with no resolvable owner (`ownerEmail`/`ownerPhone` omitted or unmatched) is owned by the same shared unclaimed-listing placeholder account every other unclaimed listing uses — there is no separate "Prospect" data model. It is structurally identical to a manually-seeded unclaimed listing and requires no special handling to appear in the unclaimed worklist or be claimed.                                                                                                   |
| BR-167 | The unclaimed-listing placeholder account is created lazily on first use if it does not already exist in the environment, rather than assumed pre-seeded.                                                                                                                                                                                                                                                                                                                                                          |
| BR-168 | An `ownerEmail`/`ownerPhone` supplied at admin-creation time that matches an existing account assigns that account as owner immediately (the restaurant is "pre-claimed"); the same one-owner-one-restaurant guard self-serve creation and claiming both enforce still applies to a real, resolved owner. A supplied value that matches no account falls back to the placeholder rather than erroring.                                                                                                             |
| BR-169 | `restaurant:create` and `restaurant:admin_edit` are distinct permissions, even though held by the same admin roles today — matching `restaurant:approve`/`restaurant:reject`'s precedent (BR-163). Both are held by `ADMIN_OPERATIONS` and `SUPER_ADMIN`, not `SUPER_ADMIN` alone — `ADMIN_OPERATIONS` is the realistic concierge-onboarding actor.                                                                                                                                                                |
| BR-170 | Every write an admin makes through the admin-authorized content/menu surface is audited with `actorType: ADMIN` and the acting admin's id — never mislabeled as a restaurant-user action, even though the underlying service methods are shared verbatim with the owner-side controllers.                                                                                                                                                                                                                          |
| BR-171 | Menu content is invisible on the public storefront until the owning restaurant is `ACTIVE`, regardless of whether an owner or an admin entered it — the existing visibility gate applies uniformly by author.                                                                                                                                                                                                                                                                                                      |
| BR-172 | A restaurant owner can see that Direct-Order staff made a recent change to their listing (action and timestamp), without exposing which specific admin made it or the raw before/after diff.                                                                                                                                                                                                                                                                                                                       |
| BR-173 | Admin-side restaurant creation surfaces potential duplicate listings (by name) as an advisory warning only — it never blocks creation. Outreach happens under time pressure and name collisions are common; a hard block would obstruct the workflow this phase exists to enable.                                                                                                                                                                                                                                  |
