# TODOS

## Settlements & Admin

### Settlement Ledger (Phase 21b)

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

### Admin-authorized menu-image upload

**What:** A presigned upload endpoint for the new admin-side menu editor (Phase 22), mirroring
`apps/api/src/modules/restaurants/controllers/upload.controller.ts`'s shape but gated by
`restaurant:admin_edit` instead of tenant membership.

**Why:** Found while implementing Phase 22's admin menu surface — the existing upload endpoint is
tenant-scoped (`restaurant:branding`, membership-gated), so an admin has no way to host a menu
photo and can only paste an already-hosted `imageUrl`. This is a real, direct gap in Phase 22's
own headline use case ("load a menu from photos an owner texted you") — the admin can enter every
other field from a photo, but not attach the photo itself as an item image.

**Effort:** S
**Priority:** P2
**Depends on:** None
