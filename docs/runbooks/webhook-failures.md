# Runbook: Webhook failures

Alert: **Webhook signature failures > 5 in 10 min** — CRITICAL, possible attack (docs/10 §17.6). Also relevant: `WebhookEvent.status = FAILED` accumulating, or `queue-backlog`-style outbox growth caused by downstream webhook processing.

## Symptoms

- Payment-provider (or delivery-provider) webhooks are not moving orders/deliveries into their expected next state despite the provider showing the event as sent.
- `WebhookEvent` rows stuck at `RECEIVED` (never reaching `PROCESSED`) or accumulating `FAILED`.
- A spike in signature-verification failures, which is either an attacker probing the webhook endpoint or a misconfigured/rotated webhook secret.

## Diagnostic commands

1. Query `WebhookEvent` by `status` and `provider` (`razorpay` / the mock/real delivery provider name) for the incident window.
2. For signature failures specifically: confirm whether they're all from one source IP/pattern (possible probing — see [suspected-data-breach.md](suspected-data-breach.md) if credential compromise is plausible) or a uniform failure across all events (near-certain secret misconfiguration — check `RAZORPAY_WEBHOOK_SECRET` / the delivery-provider webhook secret against what the provider dashboard currently has configured).
3. `GET /admin/system-health` — check `outbox.pending`/`outbox.oldestPendingAgeSeconds`, since a webhook that never resolves an order out of a waiting state can itself cause outbox/notification backlog downstream.
4. Check whether this is a delivery-side or payment-side webhook — the two are independent `WebhookEvent` rows (`provider` distinguishes them) and have different blast radii (docs/10 §16.5: delivery-provider-down orders stay accepted-but-not-dispatched; payment webhook failures risk stuck `PENDING_PAYMENT` orders).

## Immediate mitigation

- **Secret mismatch**: rotate/correct the environment variable (`RAZORPAY_WEBHOOK_SECRET` or equivalent) to match the provider dashboard's current signing secret, redeploy. Every webhook handler in this codebase verifies signatures before trusting payload contents (docs/09 §15's "every webhook is untrusted, duplicated, possibly out of order") — do not disable or bypass signature verification to "unblock" processing, even temporarily.
- **Suspected probing/attack**: if signature failures are clustered and not explained by a secret rotation, treat as a possible attack — see [suspected-data-breach.md](suspected-data-breach.md) for the escalation path. Do not change any secret in response to an active probe without confirming it first (rotating mid-attack can mask the signal you need to investigate it).
- **Processing failures (valid signature, handler errors)**: check the API error logs for the specific handler exception; these are usually a downstream bug (a state-transition being rejected because the order isn't in the expected prior state) rather than a webhook-transport problem.

## Recovery

- Every `WebhookEvent` row is durable and idempotent by design (`(provider, providerEventId)` uniqueness) — once the root cause is fixed, the provider's own webhook retry policy (or a manual replay from the provider's dashboard, where supported) will redeliver anything genuinely missed. No custom replay tooling exists in this codebase beyond `POST /admin/notifications/:id/retry` for notification-side retries specifically.
- Confirm the fix by watching new `WebhookEvent` rows reach `PROCESSED` for the affected provider.

## Verification

- `GET /admin/system-health` — `outbox` and `notifications` backlog returning to baseline.
- No new `CRITICAL`/`HIGH` reconciliation issues attributable to the incident window.

## Escalation

- Signature failures that look like a deliberate probe rather than misconfiguration: escalate as a security incident immediately, per [suspected-data-breach.md](suspected-data-breach.md).
- Provider confirms events were sent but this system shows no matching `WebhookEvent` row at all (not even `FAILED`): escalate to the provider — likely a delivery-side outage on their end, or a network/firewall issue in front of this API.
