# 22–23. Ambiguities and Risk Register

# 22. Known ambiguities

Each item states the ambiguity, the interpretations available, the recommended default, and the reasoning. **The recommended default is implemented behind configuration** so a product decision can change it without a rewrite.

Items marked **REQUIRES PRODUCT DECISION** must be answered by the product owner. Items marked **BLOCKING** must be answered before that capability goes live with real money or real customers.

---

## AMB-1 — Layer 2 discovery: forbidden or required?

**Conflict.** The product requirements state that the shared discovery marketplace must not be built, that each restaurant's link works independently, and that there is deliberately no central app customers must discover restaurants through. A later requirement then specifies cross-restaurant search, filtering, "browse nearby", popularity ranking, and a discovery page with "nearby / popular / top rated" sections. **These describe the same surface.** Cross-restaurant discovery _is_ Layer 2.

**Interpretations**

1. Discovery was deferred; the later requirement was written without reference to the earlier constraint.
2. Scope genuinely expanded and Layer 2 is now in scope.
3. Search is intended only _within_ a restaurant's menu, plus admin search.

**Recommended: interpretation 3 for launch, with 1 as the path forward.** Ship in-restaurant menu search and admin search. Build cross-restaurant discovery behind `DISCOVERY_ENABLED=false`.

**Why.** The strategic argument in the source material is specific and well-evidenced: ONDC-adjacent attempts failed precisely because they were thin discovery layers, and the product's stated edge is owning fulfilment for restaurants already going direct. Launching a marketplace before the direct-ordering layer has proven demand would repeat the failure the strategy was built to avoid. Building the code but not enabling it costs little and keeps the option open.

**REQUIRES PRODUCT DECISION.**

---

## AMB-2 — Do customers have accounts?

**Conflict.** Guest checkout with no forced signup is specified as a core principle. But loyalty balances, referral attribution, a notification centre with preferences, review history, and customer support case history all require durable customer identity.

**Recommended:** guest checkout remains the default and is never blocked. A **lightweight optional account** (phone OTP, no password) unlocks loyalty, referrals, preferences, and case history. Guest orders remain trackable via a signed order-access token. Guests do **not** earn loyalty points.

**Why.** Forcing registration at checkout is the single most damaging conversion change possible for this product, and the whole premise is a frictionless direct link. Phone-OTP accounts are familiar in India and cost the customer almost nothing. Letting guests silently accrue points creates an identity-merging problem later that is far worse than declining to award them.

Open sub-question: should points earned as a guest be retroactively granted on later registration with the same phone? **Recommend no** for v1 — the deduplication and fraud surface is not worth it.

**REQUIRES PRODUCT DECISION.**

---

## AMB-3 — Payment settlement structure

**Unresolved in the source material and explicitly flagged there.** Do funds settle to a platform account and then to restaurants, or directly to each restaurant?

**Interpretations**

1. **Platform collects, then remits.** Simple to build; likely makes the platform a payment aggregator, which in India carries RBI licensing implications, and the platform holds customer funds.
2. **Direct settlement to each restaurant** (Razorpay Route or per-restaurant sub-merchant accounts). Each restaurant completes its own KYC; the platform never holds funds.

**Recommended: interpretation 2 — split settlement via Razorpay Route.**

**Why.** It keeps the platform out of the payment-aggregator regulatory perimeter, matches the product's transparency promise (restaurants see money arriving in their own account), and removes the reconciliation and trust burden of holding other people's money. The cost is slower onboarding — each restaurant must complete KYC.

**BLOCKING for real payments. REQUIRES PRODUCT DECISION and legal review.** Until it is resolved, run in test mode only. Do not process real money on an assumption.

---

## AMB-4 — Platform fee and business model

No fee model is finalised — the source material states the pilot may be free and that a decision is needed before scaling.

**Recommended:** `PLATFORM_FEE_BPS = 0` for the pilot, with the fee mechanism fully implemented, rendered in every breakdown, and switchable per restaurant. A zero fee renders as absent rather than a confusing "₹0" line.

**REQUIRES PRODUCT DECISION before scaling.**

---

## AMB-5 — Slug changes and existing links

A restaurant's shared links, QR codes, and packaging stickers all carry its slug. Changing it breaks every one of them.

**Recommended:** allow slug changes, retain the previous slug as a 301 redirect for 90 days, warn clearly in the UI, and rate-limit to one change per 30 days. Reserve the old slug against reuse by another restaurant permanently.

**Why.** Printed QR codes cannot be recalled. A permanent redirect for a bounded period, plus permanent reservation, prevents both breakage and hijacking.

---

## AMB-6 — Can customers cancel their own orders?

Requirements reference customer cancellation without specifying when it is allowed.

**Recommended:** a customer may cancel only while the order is **PLACED** (paid, not yet accepted), receiving a full automatic refund. After acceptance, cancellation requires contacting support — food may already be in preparation.

**Why.** This protects the restaurant from absorbing the cost of prepared food while keeping the common case (ordered by mistake, restaurant has not started) self-service. **REQUIRES PRODUCT DECISION** — restaurants may want zero customer-initiated cancellation.

---

## AMB-7 — Refund policy on admin cancellation

**Recommended:** full refund for any order cancelled before DELIVERED, with the reason recorded. Partial refunds require an explicit finance decision.

**Why.** Partial-refund discretion invites disputes and is hard to apply consistently. Full-refund-by-default is defensible, simple, and reconcilable.

---

## AMB-8 — Refund policy on delivery failure

Delivery can fail for reasons attributable to the customer (unreachable, wrong address) or to the courier/restaurant.

**Recommended:** delivery failure **never auto-refunds**. It creates a HIGH-priority support case with the order context and an admin decision. Configure a default disposition per failure reason once real-world data exists.

**Why.** Auto-refunding on customer-unreachable failures makes the restaurant absorb both food cost and delivery cost through no fault of its own — the opposite of what this product promises restaurants. **REQUIRES PRODUCT DECISION.**

---

## AMB-9 — Coupon usage on cancellation after payment

**Recommended:** usage is **not** returned once payment is captured. The coupon is consumed.

**Why.** Returning it enables a farming loop: claim a limited coupon, pay, cancel, repeat. Cancellation is comparatively rare; a customer with a genuine grievance can be issued a replacement coupon through support. **REQUIRES PRODUCT DECISION.**

---

## AMB-10 — Discount stacking

Coupons, restaurant promotions, platform promotions, loyalty redemption, and referral coupons can all apply to one order. No stacking rule is specified.

**Recommended:**

- At most **one promotion or coupon** per order. If several are eligible, apply the one giving the greatest customer benefit and state which was applied.
- **Loyalty redemption may combine** with one promotion, applied after the promotion discount.
- Combined discounts never exceed the discountable base; the total never goes below zero.
- Order of application: items subtotal → promotion discount → loyalty redemption → fees → taxes.

**Why.** Unrestricted stacking is the most common source of unintended free orders and is very hard to reason about during an incident. **REQUIRES PRODUCT DECISION**, particularly on whether loyalty should combine at all.

---

## AMB-11 — Loyalty earning base

**Recommended:** earn on the **items subtotal only**, excluding fees, taxes, discounts, and delivery. Default `LOYALTY_POINTS_PER_100_INR = 1`.

**Why.** Earning on the total lets a customer accrue points on delivery fees and taxes, which are pass-through costs, not margin. Earning on the discounted subtotal keeps reward cost proportional to actual food revenue.

---

## AMB-12 — Negative loyalty balance after clawback

If a customer redeems points, then the order is refunded, clawback can exceed the current balance.

**Recommended:** allow the balance to go negative and block redemption while negative. Surface it clearly to support.

**Why.** Clamping at zero silently forgives a real debt and breaks the ledger-to-balance reconciliation that catches genuine bugs. Preserving ledger truth is worth the slightly awkward customer state, which is rare. **REQUIRES PRODUCT DECISION** — a business may prefer to clamp and write off.

---

## AMB-13 — Tax treatment

GST rates, inclusive versus exclusive pricing, and per-item versus order-level application are not specified, and Indian restaurant GST treatment varies by registration type and service mode.

**Recommended:** implement a configurable per-restaurant tax rate applied at order level, defaulting to **tax-inclusive display** (menu price includes tax), which is the norm Indian customers expect. Persist the tax component separately in the breakdown regardless.

**REQUIRES PRODUCT DECISION with qualified tax advice.** Do not go live with real money on an assumed tax treatment.

---

## AMB-14 — Delivery fee to customer versus provider cost

The customer-facing delivery fee and the amount paid to the courier provider need not match, and the difference is a business decision.

**Recommended:** store them as separate fields from the start (already in the schema). Default to charging the customer the provider quote with no markup during the pilot, and show it transparently.

**REQUIRES PRODUCT DECISION before any subsidy or markup is introduced.**

---

## AMB-15 — Restaurant self-serve promotions

Whether restaurants may create their own promotions, or only the platform may, is not stated.

**Recommended:** restaurants may create promotions scoped to their own restaurant (they bear the discount cost); only admins create platform-wide promotions. Enforced by the permission model.

---

## AMB-16 — Review moderation model

**Recommended:** reviews publish immediately (`PUBLISHED`), with reactive moderation on report. Pre-moderation is available via configuration but off by default.

**Why.** Pre-moderation on a small team means reviews sit invisible for days, which restaurants experience as suppression. Reactive moderation with a clear report path is the standard model and matches available operational capacity.

---

## AMB-17 — Data retention periods

Financial-record retention in India is commonly cited as 7–8 years, but the exact obligation depends on entity type and registration.

**Recommended defaults, all configurable:** financial records 7 years · audit logs 3 years · analytics events 13 months · support cases 3 years · sessions 30 days.

**REQUIRES LEGAL REVIEW.** Do not represent these as compliant; they are engineering defaults pending advice.

---

## AMB-18 — Guest order access token lifetime

**Recommended:** 30 days, single-order scope, HMAC-signed. Long enough to cover the realistic support window, short enough to limit exposure from a shared or leaked link.

---

## AMB-19 — Admin-created restaurant / unclaimed-listing reconciliation (Phase 22)

Phase 22 needed a policy for how an admin creating a restaurant on an owner's behalf reconciles with the pre-existing "unclaimed listing" (Prospects) concept. Investigation found there is no separate `Prospect`/`Claim` data model to reconcile with — an unclaimed listing is, and has always been, a plain `Restaurant` row owned only by the shared placeholder account (`unclaimed-listings@direct-order.local`). "Reconciliation" therefore reduces to one decision at creation time, not an ongoing sync problem.

**Decided (implemented, not just recommended):**

- Admin-side creation resolves an owner from an optional `ownerEmail`/`ownerPhone`. A match assigns that account as owner immediately (the restaurant is "pre-claimed," same one-owner-one-restaurant guard as self-serve creation/claiming applies). No match, or nothing supplied, falls back to the shared placeholder — the restaurant is then structurally identical to every other unclaimed listing, with zero special-casing anywhere else in the codebase.
- The existing `POST /restaurants/claim` endpoint is left completely unmodified. If a real owner later claims a restaurant an admin already fully built (menu, branding, hours), the existing claim logic already does the right thing: it swaps the `RestaurantStaff` row's owner and resets `status`/`onboardingStatus`, while leaving all the admin-entered content (menu, branding, hours) untouched.
- Duplicate-listing detection at creation time is **advisory only** — the admin-create UI surfaces name matches from the existing restaurant search, but creation is never blocked on it. Outreach happens under time pressure and name collisions (e.g. common restaurant names) are expected; a hard block would obstruct the acquisition motion this phase exists to support.

No further reconciliation mechanism (a merge tool, a dedup job, a second "Prospect" table) is planned — the placeholder-ownership convention already generalizes to every creation path without one.

---

# 23. Risk Register

| ID      | Risk                                                                                                                                  | Category             | Severity     | Likelihood | Mitigation                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| RISK-1  | **Payment settlement structure unresolved** — building on the wrong model requires reworking payments, onboarding, and reconciliation | Financial / Legal    | **CRITICAL** | High       | AMB-3. Provider adapter isolates the change. Do not process real money until decided                                              |
| RISK-2  | **Cross-tenant data leak** — one restaurant sees another's customers or revenue                                                       | Security             | **CRITICAL** | Medium     | Guards + repository scoping + parameterised isolation suite + optional RLS. Highest test priority                                 |
| RISK-3  | **Delivery provider API unavailable** — Uber Direct self-serve access in Bengaluru unconfirmed                                        | Technical / Business | **HIGH**     | High       | Provider abstraction + mock adapter; manual dispatch fallback; never claim production delivery when mocked                        |
| RISK-4  | **Duplicate or missed financial operation** under concurrency or webhook retry                                                        | Financial            | **CRITICAL** | Medium     | Database-level idempotency constraints, row locking, outbox pattern, reconciliation, dedicated concurrency tests                  |
| RISK-5  | **Payment gateway KYC delay** blocks launch                                                                                           | Business             | **HIGH**     | Medium     | Start KYC immediately, in parallel with development. Not an engineering task                                                      |
| RISK-6  | **Restaurant misses an order** — dashboard closed, connection dropped, notification failed                                            | Operational          | **HIGH**     | Medium     | SSE + replay + polling fallback + SMS alert + audible indicator. Database is authoritative, never the stream                      |
| RISK-7  | **Webhook forgery** marks unpaid orders paid                                                                                          | Security / Financial | **CRITICAL** | Low        | Raw-body signature verification, constant-time comparison, replay protection, amount verification, alerting on signature failures |
| RISK-8  | **Scope overrun** — building loyalty, referrals, and discovery before the pilot proves demand                                         | Delivery             | **HIGH**     | High       | Phases 1–11 are the pilot. Do not start Phase 12 before a real restaurant is live                                                 |
| RISK-9  | **Backups never restore-tested** — discovering this during an incident                                                                | Operational          | **HIGH**     | Medium     | Monthly restore drill; report `NOT VERIFIED` until one passes                                                                     |
| RISK-10 | **Promotion or loyalty abuse** — coupon farming, referral rings, reward loops                                                         | Financial            | **MEDIUM**   | Medium     | Server-side limits with row locking, reservation model, qualification on delivery, one-referrer-per-customer, rate limits         |
| RISK-11 | **WhatsApp/DLT approval delay** degrades order alerting                                                                               | Operational          | **MEDIUM**   | High       | SMS-first; WhatsApp as enhancement; in-app always available                                                                       |
| RISK-12 | **Timezone and overnight-hours bugs** — restaurant shown closed while open                                                            | Technical            | **MEDIUM**   | Medium     | Single availability authority, restaurant-timezone evaluation, explicit overnight tests                                           |
| RISK-13 | **Analytics or notification failure rolling back a transaction**                                                                      | Technical            | **HIGH**     | Low        | Outbox pattern, async consumers, explicit tests that provider outage does not affect order state                                  |
| RISK-14 | **Postgres search outgrown** as restaurant count rises                                                                                | Scalability          | **LOW**      | Low        | Documented migration triggers; act on measurement, not anticipation                                                               |
| RISK-15 | **Admin account compromise**                                                                                                          | Security             | **HIGH**     | Low        | Mandatory MFA, short sessions, full audit, no state-machine override, least-privilege admin roles                                 |
| RISK-16 | **Tax treatment incorrect** — under-collecting GST creates liability                                                                  | Legal / Financial    | **HIGH**     | Medium     | AMB-13. Configurable, separately persisted, requires professional advice before live operation                                    |
| RISK-17 | **Solo-team operational load** — one person cannot run 24/7 incident response                                                         | Operational          | **MEDIUM**   | High       | Alert only on genuinely actionable conditions; runbooks; graceful degradation; managed infrastructure                             |
| RISK-18 | **Order state corruption via manual intervention**                                                                                    | Financial / Data     | **HIGH**     | Low        | No override path exists; corrections are compensating operations; all transitions audited                                         |

## Risk posture

The three risks that most threaten the project are **RISK-1** (settlement model — a business and legal decision that engineering cannot resolve), **RISK-3** (delivery access — an external dependency), and **RISK-8** (scope overrun — an internal discipline problem).

Two of the three are outside engineering's control. The architecture responds by isolating both behind adapters so the system can be built, tested, and demonstrated end to end while they are being resolved. The third is addressed by the phase ordering: the pilot is complete at Phase 11, and everything after it is explicitly optional until a real restaurant is live.
