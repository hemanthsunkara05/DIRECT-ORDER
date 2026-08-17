# Phase 21 — Settlement Ledger & Fast-Path Restaurant Approval

Paste the section below into Claude Code from the repo root.

---

## Context

The system collects customer payments into the platform's Razorpay account and computes a
per-order platform fee (`Order.platformFeeMinor`), but **there is no code path that tracks or
discharges what the platform owes each restaurant**. Verified against the current tree:

- No payout, settlement, ledger, or invoice model exists in `prisma/schema.prisma`.
- No bank / UPI / IFSC / VPA fields exist anywhere in the schema.
- `Payment` tracks `capturedMinor` / `refundedMinor`; `Refund` and `ReconciliationIssue` exist.
  Nothing aggregates these into "restaurant X is owed Y for period Z."

Separately, restaurant onboarding self-serves only as far as `PENDING_APPROVAL`
(`RestaurantProfileService`, `apps/api/src/modules/restaurants/services/restaurant-profile.service.ts:160`).
Going live requires an admin with the `restaurant:approve` permission to call
`POST /admin/restaurants/:id/approve` (`RestaurantStateService.approve`). Today nothing notifies
an admin that a submission is waiting, and nothing tells the restaurant where it stands — so the
gate can silently cost a new restaurant hours or days.

Business context: the immediate goal is signing 10–20 boycotting restaurants in Bengaluru onto
live ordering links. Time-to-live and trustworthy money handling are the two things that matter.
Sophistication that does not serve those two goals is out of scope.

---

## Work item 1 — Settlement ledger (money owed out)

**Approach: ledger first, provider-port-ready.** Do NOT integrate Razorpay Route or any split-payment
API in this phase. Restaurants must not be required to complete Razorpay KYC to go live — that
friction directly undermines the acquisition goal. Payouts are executed manually (bank transfer /
UPI) outside the system; this phase makes the system the authoritative record of what is owed,
what has been paid, and what remains.

Design the payout execution boundary as a port, following the existing
`PaymentProvider` / `DeliveryProvider` pattern in `apps/api/src/modules/payments/providers/` and
`apps/api/src/modules/delivery/providers/`, so a `RazorpayRoutePayoutProvider` can be added later
without reworking the ledger. Ship a `ManualPayoutProvider` as the only implementation.

### Required behaviour

1. **Per-order settlement entry.** When an order reaches a terminal, money-final state, record an
   immutable ledger entry: gross collected, platform fee, payment-gateway fee (if known),
   refunds attributable to that order, and net payable to the restaurant. Derive amounts from the
   `Payment`/`Refund` rows, never recompute from stale `Order` fields.
   - Decide and document explicitly which order/payment state triggers the entry, and how a refund
     issued *after* the entry is written is represented (a reversing entry, not a mutation).
2. **Restaurant payout details.** Add the fields needed to actually pay a restaurant (account name,
   account number, IFSC, and/or UPI VPA). Treat these as sensitive: follow the codebase's existing
   posture in `docs/09-security.md` for storage, access control, audit logging, and redaction in
   logs and API responses. Only the restaurant owner and permission-bearing admins may read or
   write them. Never log them.
3. **Settlement periods and statements.** Aggregate entries into a settlement period per restaurant
   (choose weekly or configurable; justify the choice). A period must be viewable as a statement:
   order-level lines, totals, fees deducted, net payable.
4. **Payout records.** An admin can mark a period as paid, capturing amount, method, reference
   number, paid-at, and the acting admin. Recording a payout must be idempotent and audit-logged.
   A period already marked paid cannot be silently re-paid or edited — corrections are new entries.
5. **Restaurant-facing view.** The restaurant sees its own earnings: current unsettled balance,
   past statements, and payout history. This is a trust surface — the entire premise of the product
   is fee transparency the aggregators do not offer. Every deduction must be itemized and legible.
6. **Admin-facing view.** A list of restaurants with outstanding balances, drill-down to statement,
   and the mark-as-paid action.
7. **Reconciliation.** Extend or mirror the existing `ReconciliationIssue` mechanism so that a
   mismatch between collected money and ledger totals surfaces as an issue rather than silently
   drifting.

### Money-handling constraints (non-negotiable)

- All amounts in minor units as `BigInt`, consistent with the existing schema. Use `packages/money`.
  Never use floating point for money.
- Ledger entries are append-only. Corrections are reversing entries, never in-place updates.
- Any operation that could double-count or double-pay must be idempotent and row-locked, following
  the pattern already used in `RefundService` (locks the `Payment` row before creating a `Refund`).
- Invariant: for any restaurant, `sum(net payable entries) - sum(payouts recorded) = outstanding
  balance`, and this must hold under concurrent order completion and payout recording. Test it.

---

## Work item 2 — Fast-path restaurant approval

**Keep the approval gate. Remove the latency, not the check.** A live page that collects customer
payments must not appear without a human having looked at it. But a restaurant that finishes
onboarding at 11pm should not wait until someone happens to check a dashboard.

### Required behaviour

1. **Notify on submission.** When a restaurant transitions `DRAFT → PENDING_APPROVAL`, notify
   admins through the existing notification system (`apps/api/src/modules/notifications/`, which
   already has email/SMS/WhatsApp channels wired). Add the template to the existing notification
   catalogue rather than inventing a parallel mechanism.
2. **Approval queue.** An admin view listing pending submissions oldest-first, showing everything
   needed to make the call on one screen (profile, address, menu, branding, contact), with approve
   and reject actions inline. Reject must capture a reason.
3. **Reject path.** `PENDING_APPROVAL → REJECTED` currently has no admin API surface
   (`RestaurantStateService` documents this). Add it, along with `REJECTED → PENDING_APPROVAL`
   resubmission, so a fixable problem does not dead-end a prospect. Notify the restaurant on
   both reject (with the reason) and approve (with its live link).
4. **Status visibility for the restaurant.** The restaurant dashboard must clearly show its current
   state, what is blocking it, and what happens next — no silent waiting.
5. **Measure it.** Record submitted-at and decided-at so time-to-approval is queryable. This is the
   metric the acquisition push will be judged on.

Do not weaken any existing authorization check. Approval remains `restaurant:approve`-gated.

---

## How to work

Follow `docs/16-execution-protocol.md` §24.2 — the standing loop for this repo:

```
READ the relevant specs → INSPECT existing code → PLAN → IMPLEMENT → TEST → VALIDATE → REVIEW → REPORT
```

Before writing code:

1. Read `IMPLEMENTATION_HANDOFF.md`, `docs/15-ambiguities-and-risks.md` (do not invent business
   rules that were deliberately left open), `docs/02-database-schema.md`, `docs/06-business-rules.md`,
   `docs/05-authorization-matrix.md`, and `docs/09-security.md`.
2. Inspect the existing payments, refunds, reconciliation, admin, and notifications modules. Match
   their structure exactly — controller / service / repository split, DI tokens, response envelope
   (`platform/http/response-envelope.ts`), error types (`platform/errors/app-error.ts`), audit
   logging, tenancy scoping.
3. Extend the existing numbering conventions rather than starting new ones: business rules continue
   from BR-158 in `docs/06-business-rules.md`; add new rules there, plus schema changes to
   `docs/02-database-schema.md`, endpoints to `docs/04-api-specification.md`, permissions to
   `docs/05-authorization-matrix.md`, and acceptance criteria to `docs/14-acceptance-criteria.md`.
4. Consider running `/plan-eng-review` on your plan before implementing — this touches money
   handling, and the ledger's invariants are easier to fix on paper than in migrations.

Work autonomously within the phase. Per §24.3, stop only for a genuine product decision you cannot
infer, missing credentials or external configuration, or a destructive/irreversible action.

## Definition of done

- Prisma migration created and applied cleanly; schema documented.
- Unit and integration tests covering: ledger arithmetic, the outstanding-balance invariant under
  concurrency, refund-after-settlement reversal, payout idempotency, authorization on every new
  endpoint (including negative cases — a restaurant must not read another restaurant's ledger),
  and the full approval state machine including reject and resubmit.
- Typecheck, lint, build, and the full existing test suite pass with no regressions.
- Payout details verified absent from logs and from any API response not explicitly authorized.
- Docs updated as listed above.
- Report what changed, what you decided where the spec was silent, and what you deliberately left
  out of scope.

## Explicitly out of scope

- Razorpay Route, split payments, or any automated money movement.
- Restaurant KYC collection beyond the payout fields needed to transfer money.
- Tax/GST invoice generation (flag it if you believe it blocks real settlement, but do not build it).
- Auto-approval logic or any relaxation of the approval gate.
