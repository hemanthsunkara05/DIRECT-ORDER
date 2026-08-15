# Runbook: Payment failure spike

Alert: **Payment success rate < 90% over 15 min** — CRITICAL (docs/10 §17.6).

## Symptoms

- The alert above fires, or `GET /admin/payments` shows a cluster of `FAILED`/unconfirmed payments in a short window.
- Customers report checkout errors; `POST /public/checkout` completion rate drops.
- Support tickets referencing "payment failed" or "money debited, order not placed" spike (`GET /admin/support`).

## Diagnostic commands

1. `GET /admin/payments?status=FAILED` (or the equivalent DB query) — confirm the spike is real and get the time window.
2. Check whether failures cluster on one payment method/bank, or are provider-wide (Razorpay dashboard/status page) vs application-side.
3. Check recent deploys against the failure-window start time — a bad deploy touching checkout/payment code is the first suspect (see [bad-deployment.md](bad-deployment.md)).
4. `GET /admin/reconciliation-issues?severity=CRITICAL` — confirm no `ORDER_TOTAL_IDENTITY_VIOLATION` or `ORDER_PLACED_WITHOUT_CAPTURED_PAYMENT` entries are appearing alongside the spike (would indicate a correctness bug, not just a provider issue).
5. Check API error logs for the payment-provider client (signature/timeout/5xx from the provider vs 4xx validation failures from this codebase).

## Immediate mitigation

- If the provider itself is down/degraded: this codebase already fails safe — docs/10 §16.5, "Payment provider down → checkout blocked with a clear message, never fabricate success, existing orders continue to be fulfilled." No override is needed or should be attempted; do not weaken this behavior to "let orders through" during an incident.
- If the failures are application-side (a bad deploy, a config error such as a rotated API key not yet propagated): roll back per [bad-deployment.md](bad-deployment.md), or fix the config (e.g. `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`) and redeploy.
- Post a visible status update if checkout is materially degraded for more than a few minutes — customers should not be left guessing.

## Recovery

- Once the root cause (provider outage, bad config, bad deploy) is resolved, confirm the payment success rate has returned above 90% over a fresh 15-minute window before standing down.
- Run the data-integrity assertion suite manually (`DataIntegrityService.runAll()`, or wait for its daily scheduled run) rather than waiting a full day, if the incident could plausibly have produced orphaned `PENDING_PAYMENT` orders or missed webhooks.

## Verification

- `GET /admin/system-health` — `outbox` backlog is not elevated (a payment-provider outage can also cause webhook backlog once the provider recovers and replays events — see [webhook-failures.md](webhook-failures.md)).
- No new `CRITICAL` reconciliation issues since recovery.
- Spot-check a handful of orders placed during the incident window: each is in a terminal or legitimately-progressing state, never stuck `PENDING_PAYMENT` past the order-expiry window (`OrderExpiryScheduler` should have already expired anything abandoned).

## Escalation

- Provider-side outage lasting > 30 minutes: escalate to the payment provider's support channel with the affected time window and any error codes captured.
- Any correctness signal (reconciliation issue, mismatched totals) found during triage: treat as a financial-integrity incident, not just an availability incident — escalate immediately regardless of whether the failure rate has already recovered.
