# Runbook: Queue backlog

Alerts: **Any DLQ non-empty ≥ 1 — HIGH**; **Queue oldest job age > 10 min — HIGH** (docs/10 §17.6).

## Architecture note (read first)

This codebase has no standalone BullMQ/message-broker worker process yet — `apps/worker`'s job-processing loop remains the Phase-1 stub with no processors registered. Every "queue" in this system today is one of a small set of self-starting, in-process `setInterval` pollers running inside `apps/api` (`OutboxService`, `OrderExpiryScheduler`, `NotificationRetryScheduler`, `LoyaltyReconciliationService`, `AnalyticsRollupService`, `DataIntegrityService`). This is a genuine architectural gap, tracked as a known issue (see PHASE_REPORTS.md's Phase 19 entry) — **this runbook covers the queues that actually exist**, not the BullMQ topology docs/07 originally envisioned.

`GET /admin/system-health` (Phase 19) is the authoritative source for the two backlogs that map onto docs/10's threshold table:

- **Outbox** (`outbox_events`, `PENDING` count + oldest-pending age) — the webhooks/payments-queue equivalent. Thresholds: 50/200 pending = warning/critical, 2min/10min oldest age = warning/critical.
- **Notifications** (`notifications`, `PENDING`/`DEAD_LETTERED` counts) — the notifications-queue/DLQ equivalent. Thresholds: 500/2000 pending = warning/critical, 1/10 dead-lettered = warning/critical.

## Symptoms

- `GET /admin/system-health` reports `outbox.status` or `notifications.status` as `warning`/`critical`, or `notifications.deadLettered > 0`.
- Downstream effects lag: notifications arrive late, outbox-driven side effects (webhooks fan-out, analytics) fall behind.

## Diagnostic commands

1. `GET /admin/system-health` — read `outbox.pending`, `outbox.oldestPendingAgeSeconds`, `notifications.pending`, `notifications.deadLettered` directly.
2. If notifications specifically: `GET /admin/notifications?status=DEAD_LETTERED` to see which ones failed and why (each carries its last failure reason).
3. Check whether the API process itself is healthy (a backlog is often a symptom of the API being under load or restarting frequently, not a queue-specific problem, since these pollers run in-process).
4. Check whether a downstream dependency the pollers call is degraded (SMS/WhatsApp provider for notifications; nothing external for outbox relay itself, which is DB-only).

## Immediate mitigation

- **Dead-lettered notifications**: `POST /admin/notifications/:id/retry` retries a specific one. For a bulk dead-letter event (many at once, same cause), fix the root cause first (e.g., SMS provider credentials) — retrying before fixing the cause just re-fills the DLQ.
- **Outbox backlog**: this poller has no manual "kick" endpoint; it runs on its own interval. A growing outbox backlog with a healthy API process usually means the poller's own interval/batch size is undersized for current volume, or the process has been unhealthy/restarting — check API uptime and logs first.
- Do not manually delete backlogged rows to "clear" the alert — every outbox/notification row represents a real side effect (a webhook fan-out, a customer-facing message) that has not yet happened; deleting it silently drops that side effect instead of fixing the delay.

## Recovery

- Once the root cause is fixed (dependency restored, process stabilized), backlog should drain on its own via the existing pollers — there is no separate "resume" step, since these are not pausable queues in the traditional sense.
- For a large notification DLQ from a since-fixed transient cause, retry affected notifications individually via `POST /admin/notifications/:id/retry`, or in a small batch script if the volume is large enough to make manual retries impractical.

## Verification

- `GET /admin/system-health` — both `outbox` and `notifications` back to `ok` status.
- `deadLettered` count not climbing further.

## Escalation

- Backlog persists after the apparent root cause is fixed: likely an undersized polling interval/batch size for current traffic — this is a genuine scaling limitation of the in-process-poller architecture and should be escalated as a capacity/architecture issue, not treated as a one-off incident.
- Any backlog accompanied by a `CRITICAL` reconciliation issue: treat as a correctness incident first, backlog second.
