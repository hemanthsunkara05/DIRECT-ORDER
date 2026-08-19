# TODOS

## Settlements & Admin

### Settlement Ledger (Phase 23b)

**What:** Track money owed to each restaurant — append-only ledger entries per delivered order
(gross collected, platform fee, gateway fee if known, refunds, net payable), weekly settlement
periods with restaurant-facing statements, admin-recorded manual payouts (bank transfer/UPI,
idempotent, audited), a `PayoutProvider` port (`ManualPayoutProvider` only for now, so Razorpay
Route can slot in later without reworking the ledger), and reconciliation against captured
payment totals.

**Why:** The platform collects customer payment into its own Razorpay account but has no record
of what it owes each restaurant, and no way to pay them beyond ad hoc manual work. Trustworthy,
transparent money handling is one of the two things (alongside fast approval) that determines
whether boycotting restaurants trust this platform enough to sign on.

**Context:** Originally scoped together with the restaurant-approval fast-path (Phase 21) as one
task. Split during `/plan-eng-review`'s scope-complexity gate — the combined plan touched
~35-40 files and ~8 new service/provider classes. Approval fast-path shipped first since it's
the blocking piece (a restaurant can't generate any orders to settle until it's approved and
live). A complete design already exists from the planning pass that preceded the split: new
Prisma models (`RestaurantPayoutDetails`, `SettlementLedgerEntry`, `SettlementPeriod`,
`Payout`), the exact trigger-point reasoning (entry written on `ORDER_DELIVERED`, reversed via a
new entry — never mutated — on a later `REFUND_COMPLETED`), weekly IST-anchored periods with
justification, new permissions (`settlements:read`, `settlements:manage`,
`restaurant:payout_details`), the full API surface (restaurant- and admin-facing), and a test
plan including the outstanding-balance-invariant-under-concurrency test the original brief
explicitly required. Depends on nothing built in Phase 21 except the `submittedAt`/`decidedAt`
columns added to `Restaurant` (harmless overlap, not a real dependency).

**Effort:** XL
**Priority:** P1
**Depends on:** None (Phase 21's approval fast-path unblocks _using_ it in practice, but doesn't
block _building_ it)

**Update (Phase 23 split):** Re-bundled into a "Phase 23" brief alongside an admin command center,
delivery visibility, and menu-image upload. Split again at `/plan-eng-review`'s scope-complexity
gate for the same reason as before — still the one genuinely money-handling, high-risk piece, and
still deserves its own isolated diff with its own concurrency/invariant test pass. The other three
items shipped as Phase 23a; this entry (renamed 21b → 23b) is unchanged and still needs its own
`/plan-eng-review` pass before implementation.

### Admin notification reader endpoint

**What:** A real `/admin/notifications` reader endpoint — generalize the existing customer/
restaurant notification-center pattern (`notification-center.controller.ts`) to the `ADMIN`
recipient type, with its own pagination and read-state.

**Why:** Today `ADMIN`-recipient `Notification` rows are created (e.g. by Phase 21's
`RESTAURANT_SUBMITTED_FOR_APPROVAL`) but nothing ever reads them in-app — the notification
center controller is hardcoded to `RESTAURANT_USER`. Email is the only channel that actually
reaches an admin today.

**Context:** Deferred during Phase 21's `/plan-eng-review` (architecture finding 2) — the
Approval Queue page (`/admin/approvals`) is the authoritative always-visible surface for that
specific case, so building a full notification reader wasn't required to ship fast-path
approval. The gap is small and well-understood: the pattern already exists for two other
recipient types (`CUSTOMER`, `RESTAURANT_USER`); this is "do the same thing a third time,"
not new design. Worth revisiting once more admin-facing notification types exist beyond the one
Phase 21 adds, where a real in-app list starts pulling its weight over email alone.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Promotions admin UI

**What:** A `/admin/promotions` frontend page for the existing `promotions:platform`-gated
backend (`apps/api/src/modules/promotions/`), which already works end-to-end via direct API call.

**Why:** Explicitly out of scope for Phase 22 (which built admin-assisted restaurant/menu
management) — the backend already exists and works; only the page is missing, and the need is
rare enough pre-launch that a direct API call covers it for now.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Admin user creation

**What:** An endpoint + UI to create `AdminUser` accounts, enforcing the already-declared
`admin:role_manage` permission (currently in the catalogue but checked nowhere — confirmed via
grep, only `prisma/seed.ts`'s one hardcoded admin exists today).

**Why:** Explicitly out of scope for Phase 22. Matters once there's an admin team beyond one
person; there isn't one yet. Interim path: seed-file or direct-DB insert of an `AdminUser` row.

**Effort:** M
**Priority:** P3
**Depends on:** None

### Reconciliation-issue writer

**What:** Something that actually writes rows to `ReconciliationIssue` — e.g. a scheduled job
comparing `Payment.capturedMinor`/`refundedMinor` against `Order.payableTotalMinor`, inserting a
mismatch row with severity when they disagree.

**Why:** Found during Phase 23a — `ReconciliationIssue` exists in the schema in full (fields,
enums, indexes) but a repo-wide search found zero code anywhere that creates a row in it. It's
dead on arrival: any dashboard tile built against it today would always read "0 issues," not
because reconciliation is clean, but because nothing is checking. Explicitly left out of Phase
23a's alerts panel for exactly this reason rather than shipping a decorative tile.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Restaurant Hardware / Always-On Ops (post-launch, not yet built)

### Always-on kitchen/handler order screens

**What:** A kiosk-mode-friendly, real-time, auto-refreshing order-list view usable as a
permanently-open browser tab on a restaurant's kitchen/counter device. Supports multiple staff
logins open simultaneously for the same restaurant (e.g. a kitchen screen showing just the order
queue, and a separate handler/manager screen with full order actions) — the existing
restaurant-staff/invitation system already supports multiple concurrent staff accounts per
restaurant, so this is a UI/real-time-push concern, not a new auth model.

**Why:** Discussed with sash — restaurants going direct need the same "always-on order screen"
experience they're used to from Zomato/Swiggy's restaurant partner apps. Still just the same
website, no native app needed; kiosk mode + real-time updates covers it.

**Effort:** TBD (needs a real-time push audit first — check what's currently polling vs.
websocket-based)
**Priority:** TBD
**Depends on:** None

### Direct receipt-printer integration

**What:** Let a restaurant connect a thermal receipt printer directly from the browser (USB via
WebUSB, Bluetooth via Web Bluetooth, or LAN/network printing to a local IP) and auto-print new
orders, no native app or separate print server required for the common case.

**Why:** Discussed with sash — restaurants need receipts printed per order. Feasible without an
installed app for most common cheap thermal printers; some budget printers only ship a
proprietary Android/Windows SDK, which would need a fallback (e.g. a tiny local print-bridge
app) — needs a hardware-compatibility check before committing to a browser-only approach.

**Effort:** TBD (needs a printer-model compatibility spike first)
**Priority:** TBD
**Depends on:** None

## Future stages — reviewed against a Zomato-scale enterprise admin spec (2026-08-19)

sash shared a spec written for Zomato's actual scale (multi-city, millions of orders, multiple
monetization models). Most of it is over-scoped for a 10-20 restaurant single-city pilot; some of
it (commission/recharge/subscription monetization) actively contradicts this product's pitch
("restaurant keeps ~95%+, sees every fee" — a flat transparent model, not Zomato's tiered
commission stack). Logged here by trigger condition, not by date, so nothing gets rebuilt from
scratch when it becomes relevant — reread this list before starting any of these rather than
re-deriving requirements.

### Trigger: multiple cities / dozens of restaurants

- **Geography hierarchy** (region/state/city/zone) and a city-level ops dashboard. Meaningless
  with one city and ~20 restaurants; becomes real once there's more than one market to compare.
- **Global search** across orders/restaurants/customers/tickets. Not needed while a plain list
  fits on one screen.
- **Notification center** (in-app, categorized). Currently deferred as "Admin notification reader
  endpoint" above for the same reason — email covers current volume.

### Trigger: real transaction volume (hundreds of orders/day sustained)

- **Marketplace-wide analytics dashboard** (GMV over time, cohort analysis, city performance).
  Restaurant-level analytics already exists (`analytics:restaurant`); a platform-wide rollup is
  premature before there's enough volume for trends to mean anything.
- **Forecasting** (expected order volume, capacity warnings). Needs real historical volume to
  forecast from — building this now would forecast noise.
- **Fraud/risk scoring engine** (suspicious-order detection, coupon abuse, chargeback tracking).
  Premature at pilot scale where every order can be eyeballed; revisit once volume makes manual
  review impractical.
- **Incident management center** (formal incident tracking with severity/status workflow).
  Overkill for one admin; a shared doc or Slack thread covers this until there's an ops team.

### Trigger: an admin team beyond one person (sash)

- **Full RBAC role hierarchy** (City Manager, Merchant Success, Finance, Risk Analyst,
  Commercial Manager, Read Only, etc.) — beyond the `ADMIN_OPERATIONS`/`SUPER_ADMIN` split that
  exists today. One person doesn't need role separation from themselves.
- **Admin user creation** — already logged above; this is the actual prerequisite for any of the
  above roles to matter.
- **Approval workflows for sensitive actions** (e.g. large refunds requiring a second approver).
  Needs a second admin to approve anything.

### Trigger: multiple delivery providers, or Uber Direct proving unreliable enough to need a fallback

- **Delivery provider abstraction / fallback routing** (primary/fallback provider switching,
  routing rules). The codebase already has a `DeliveryProvider` port
  (`apps/api/src/modules/delivery/providers/delivery-provider.port.ts`) with mock + Uber Direct
  implementations, so adding a second real provider is a smaller lift than it sounds — but
  building fallback *routing logic* before there's a second provider worth routing to is wasted
  work.
- **Uber Direct reconciliation screen** (quote vs. final cost vs. provider invoice, matched/
  mismatch states). Worth building once delivery volume is high enough that manual spot-checks
  stop catching billing discrepancies.

### Explicitly rejected — contradicts the product, not just premature

- **Commission-plan / recharge-balance / subscription-tier commercial engine** (section 13/14/32
  of the reviewed spec). This is Zomato's monetization model — restaurants pay a percentage or
  prepay a balance that gets consumed per order. DirectOrder's pitch is the opposite: a flat,
  transparent, low platform fee restaurants can see broken down on every order
  (`PLATFORM_FEE_BPS`, 0 during pilot per `docs/10-infrastructure-deployment.md`). Building
  Zomato's commercial engine would undermine the actual differentiation. If monetization
  complexity is ever needed, it should still be flat-fee-transparent by design, not this.
- **Fake Uber driver controls** (driver earnings, incentives, payrol, attendance). Not the
  platform's to control regardless of scale — Uber Direct owns this layer permanently, not just
  "for now."
