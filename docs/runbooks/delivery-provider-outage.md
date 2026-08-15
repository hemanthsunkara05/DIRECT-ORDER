# Runbook: Delivery provider outage

Alert: **Delivery dispatch failures > 20% over 30 min** — HIGH (docs/10 §17.6). Documented behavior (docs/10 §16.5): *"Delivery provider down → orders accepted and prepared; dispatch queues and retries; restaurant and admin alerted. Order is not marked out for delivery."*

## Symptoms

- `GET /admin/deliveries` shows a cluster of deliveries stuck in a pre-dispatch state, or dispatch requests to the provider failing.
- Restaurant-side users report orders accepted/prepared but never handed to a rider.
- `DELIVERY_PROVIDER` is `mock` in every non-production environment (`.env.example`) — this scenario is only reachable against the real provider in a deployed environment.

## Diagnostic commands

1. `GET /admin/deliveries?status=<pre-dispatch status>` to size the affected order count and confirm the pattern is provider-wide, not restaurant/area-specific.
2. Check the delivery provider's own status page/API error responses (timeouts vs explicit rejections vs no coverage in the area).
3. Confirm whether this is a genuine provider outage vs a credential/quota issue (expired API key, exhausted quota) — the two require different fixes.

## Immediate mitigation

- **This system already fails safe here by design** — orders stay accepted and prepared, never silently marked out-for-delivery without a real dispatch confirmation. Do not manually force an order into a "dispatched" state to make the queue look clear; that fabricates a delivery signal the same way the payment-provider rule forbids fabricating a payment signal.
- Alert affected restaurants directly if the outage is expected to last more than a short window, so they can manage customer expectations (e.g., hold food, communicate delays) rather than preparing orders that will sit waiting for dispatch.
- If a credential/quota issue: rotate/renew and redeploy; this is the fast path and should be checked first before assuming a genuine provider-side outage.

## Recovery

- Dispatch retries are queued, not dropped — once the provider recovers, queued dispatch attempts should resume automatically. Confirm via `GET /admin/deliveries` that the backlog is draining, not just static.
- For orders where the delay was long enough to be unacceptable to the customer, use existing admin tooling (`POST /admin/orders/:id/cancel` with a refund, if appropriate) rather than leaving them silently stuck — but only after confirming with the restaurant, since the food may already be prepared.

## Verification

- Delivery dispatch failure rate back under the 20%/30min alert threshold.
- No `CRITICAL`/`HIGH` reconciliation issues newly opened during the incident (e.g. `DUPLICATE_DELIVERY_PER_ORDER`, which would indicate a retry created a second delivery instead of safely re-attempting the same one).

## Escalation

- Provider outage exceeding 30–60 minutes with no ETA: escalate to the delivery provider's support/account team; consider a customer-facing status notice if a meaningful share of active orders are affected.
- Any sign of duplicate dispatch (two riders assigned to the same order): escalate as a correctness incident, not just an availability one — this should be structurally prevented by this system's delivery-per-order uniqueness constraint, so its appearance would indicate a deeper bug worth investigating immediately.
