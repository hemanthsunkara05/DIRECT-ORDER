# Runbook: Reconciliation mismatch

Alert: **Reconciliation issue created, any severity CRITICAL** — CRITICAL (docs/10 §17.6). Source: `GET /admin/reconciliation-issues`, populated by `ReconciliationIssueRepository` from (a) the pre-existing payment/webhook reconciliation logic and (b) Phase 19's `DataIntegrityService`, which runs 6 named assertions daily (docs/11 §18.6): order total identity, no over-refund, no duplicate delivery per order, loyalty balance matches ledger, no order placed without a captured payment, no referral rewarded twice.

## Symptoms

- A new row appears via `GET /admin/reconciliation-issues`, with a `severity` and `issueType` identifying exactly which invariant broke and an `entityId` identifying the specific record.

## Diagnostic commands

1. `GET /admin/reconciliation-issues?severity=CRITICAL&status=OPEN` — list unresolved critical issues, most recent first.
2. Read `issueType` to route to the specific invariant:
   - `ORDER_TOTAL_IDENTITY_VIOLATION` — the order's stored line-item/fee/discount breakdown doesn't sum to its `payableTotalMinor`. Pull the exact order and manually recompute via the pricing engine's own formula to see which term is wrong.
   - `OVER_REFUND` — a payment's `refundedMinor` exceeds its `capturedMinor`. Pull all refunds against that payment and check for a race or a manual admin action that bypassed normal refund validation.
   - `DUPLICATE_DELIVERY_PER_ORDER` — more than one delivery row for one order. This is structurally prevented by `Delivery.@@unique([orderId])`; its appearance would mean that constraint was bypassed somehow (e.g. a raw query) — treat as high-priority since it implies a schema invariant was circumvented.
   - `LOYALTY_BALANCE_MATCHES_LEDGER` — a customer's computed ledger sum doesn't match their stored account balance. Pull `LoyaltyLedger` entries for that customer and recompute by hand.
   - `ORDER_PLACED_WITHOUT_CAPTURED_PAYMENT` — an order is past `PENDING_PAYMENT`/`PAYMENT_FAILED`/`EXPIRED` but has no payment with a positive captured amount. This is the most serious class — it means an order may have been fulfilled without being paid for.
   - `NO_REFERRAL_REWARDED_TWICE` — the same referral reference rewarded more than once. Structurally prevented by a partial unique index on `LoyaltyLedger`; its appearance implies that index was bypassed.
3. Cross-check the timing against recent deploys, migrations, or incidents (a bad deployment, a database outage, a payment-provider incident) — reconciliation mismatches are frequently a downstream symptom of one of the other runbooks' incidents, not a standalone root cause.

## Immediate mitigation

- Do not manually "fix" the underlying data (adjust a balance, delete a duplicate row) before understanding root cause — a manual data fix without understanding the bug risks masking a still-active bug that will keep producing new mismatches.
- If `ORDER_PLACED_WITHOUT_CAPTURED_PAYMENT` or `OVER_REFUND` (direct financial-loss risk): treat as the highest priority in this runbook set — escalate immediately rather than waiting to finish full triage.
- Mark the issue `INVESTIGATING` (via the admin tooling, once a write path exists — currently `GET /admin/reconciliation-issues` is read-only reporting; status changes go through direct DB action until a dedicated endpoint is built) so duplicate investigation doesn't happen.

## Recovery

- Fix the root cause in code first (this is a correctness bug, not an operational blip — every one of these 6 assertions represents an invariant that should be structurally impossible to violate).
- Once fixed, correct the specific affected record(s) with a deliberate, reviewed data-correction (e.g., issue a real refund for an over-charge, adjust a loyalty ledger with a compensating entry rather than mutating history) — never silently edit historical financial rows.
- Add or extend a regression test that reproduces the exact scenario that caused the mismatch, matching this codebase's established practice (every fixed bug in Phase 18 and 19 shipped with a named regression test).

## Verification

- Re-run `DataIntegrityService.runAll()` manually and confirm the specific assertion that flagged is now clean.
- `GET /admin/reconciliation-issues?status=OPEN` no longer shows the resolved issue (once marked `RESOLVED`).

## Escalation

- Any financial-loss-shaped mismatch (`OVER_REFUND`, `ORDER_PLACED_WITHOUT_CAPTURED_PAYMENT`) affecting real money: escalate immediately regardless of how few records are affected — these are exactly the invariants docs/09's threat model treats as non-negotiable.
- A mismatch type that structurally "shouldn't be possible" (`DUPLICATE_DELIVERY_PER_ORDER`, `NO_REFERRAL_REWARDED_TWICE`) appearing at all: escalate as a possible database-constraint bypass (raw SQL, a migration that dropped the constraint, direct DB access) — this is a different class of concern than a business-logic bug.
