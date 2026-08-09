# 11–12. Event Architecture and Background Jobs

## 11.1 Model

Domain events decouple modules. `ordering` does not call `loyalty`, `notifications`, or `analytics` directly — it emits `ORDER_DELIVERED` and those modules subscribe.

**Transactional outbox.** Events are written to an `outbox` table **inside the same transaction** as the state change, then relayed to BullMQ by a poller. This is the only way to guarantee that a committed order always produces its events, and that a rolled-back transaction produces none. Enqueuing directly from application code after commit loses events on crash; enqueuing before commit publishes events for work that never happened.

```
State change + outbox insert  (one transaction)
        ↓
Outbox relay (polls every 1s, marks dispatched)
        ↓
BullMQ queue
        ↓
Consumers — idempotent, retryable
```

Every event carries: `eventId` (UUIDv7), `type`, `occurredAt`, `correlationId`, `payload`, `idempotencyKey`.

**Consumer contract:** every consumer is idempotent. It may be invoked more than once for the same event and must produce the effect exactly once — enforced by a database constraint, not by checking whether work was already done.

---

## 11.2 Event catalogue

| Event                           | Producer                       | Consumers                                                                            | Idempotency key                 | Payload                                        |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------- |
| `ORDER_CREATED`                 | ordering                       | analytics                                                                            | `order:{id}:created`            | orderId, restaurantId, totals                  |
| `ORDER_PLACED`                  | ordering (on verified payment) | notifications, analytics, delivery(prewarm)                                          | `order:{id}:placed`             | orderId, orderNumber, restaurantId, customerId |
| `ORDER_ACCEPTED`                | ordering                       | notifications, analytics                                                             | `order:{id}:accepted`           | orderId, acceptedBy, estimatedPrepMinutes      |
| `ORDER_REJECTED`                | ordering                       | notifications, payments(refund), promotions(release), loyalty(release), analytics    | `order:{id}:rejected`           | orderId, reason                                |
| `ORDER_PREPARING`               | ordering                       | notifications, analytics                                                             | `order:{id}:preparing`          | orderId                                        |
| `ORDER_READY`                   | ordering                       | **delivery(dispatch)**, notifications, analytics                                     | `order:{id}:ready`              | orderId, restaurantId, addresses               |
| `ORDER_DELIVERED`               | delivery webhook → ordering    | **loyalty(earn)**, **referrals(qualify)**, reviews(enable), notifications, analytics | `order:{id}:delivered`          | orderId, customerId, subtotal                  |
| `ORDER_CANCELLED`               | ordering                       | payments(refund), delivery(cancel), promotions, loyalty, notifications, analytics    | `order:{id}:cancelled`          | orderId, reason, actor                         |
| `PAYMENT_SUCCEEDED`             | payments (verified)            | **ordering(→PLACED)**, promotions(confirm), loyalty(confirm), analytics              | `payment:{id}:captured`         | paymentId, orderId, amountMinor                |
| `PAYMENT_FAILED`                | payments                       | ordering, promotions(release), loyalty(release), notifications                       | `payment:{id}:failed`           | paymentId, orderId, failureCode                |
| `REFUND_INITIATED`              | payments                       | notifications, analytics                                                             | `refund:{id}:initiated`         | refundId, orderId, amountMinor                 |
| `REFUND_COMPLETED`              | payments (verified)            | loyalty(clawback), referrals(invalidate), notifications, analytics                   | `refund:{id}:completed`         | refundId, orderId, amountMinor                 |
| `DELIVERY_CREATED`              | delivery                       | notifications, analytics                                                             | `delivery:{id}:created`         | deliveryId, orderId, provider                  |
| `DELIVERY_COURIER_ASSIGNED`     | delivery webhook               | notifications                                                                        | `delivery:{id}:assigned`        | deliveryId, courierName, eta                   |
| `DELIVERY_PICKED_UP`            | delivery webhook               | ordering(→OUT_FOR_DELIVERY), notifications                                           | `delivery:{id}:pickedup`        | deliveryId, orderId                            |
| `DELIVERY_COMPLETED`            | delivery webhook               | ordering(→DELIVERED), notifications                                                  | `delivery:{id}:delivered`       | deliveryId, orderId                            |
| `DELIVERY_FAILED`               | delivery webhook               | ordering, notifications, support(auto-case)                                          | `delivery:{id}:failed`          | deliveryId, orderId, reason                    |
| `LOYALTY_POINTS_EARNED`         | loyalty                        | notifications, analytics                                                             | `loyalty:earn:{orderId}`        | customerId, points, orderId                    |
| `LOYALTY_POINTS_REDEEMED`       | loyalty                        | analytics                                                                            | `loyalty:redeem:{orderId}`      | customerId, points, orderId                    |
| `REFERRAL_QUALIFIED`            | referrals                      | loyalty(reward), notifications                                                       | `referral:{id}:qualified`       | referralId, referrerId, referredId             |
| `REFERRAL_REWARDED`             | referrals                      | notifications, analytics                                                             | `referral:{id}:rewarded`        | referralId, rewardPoints                       |
| `REVIEW_SUBMITTED`              | reviews                        | restaurants(aggregate), notifications, analytics                                     | `review:{id}:submitted`         | reviewId, restaurantId, rating                 |
| `REVIEW_MODERATED`              | reviews                        | restaurants(aggregate), notifications                                                | `review:{id}:moderated:{n}`     | reviewId, status                               |
| `RESTAURANT_APPROVED`           | restaurants                    | notifications, analytics                                                             | `restaurant:{id}:approved`      | restaurantId                                   |
| `RESTAURANT_SUSPENDED`          | restaurants                    | notifications, analytics                                                             | `restaurant:{id}:suspended:{n}` | restaurantId, reason                           |
| `STAFF_INVITED`                 | restaurants                    | notifications                                                                        | `invitation:{id}:sent`          | invitationId, email, role                      |
| `SUPPORT_CASE_CREATED`          | support                        | notifications, analytics                                                             | `case:{id}:created`             | caseId, category, priority                     |
| `SUPPORT_MESSAGE_ADDED`         | support                        | notifications                                                                        | `message:{id}`                  | caseId, messageId, visibility                  |
| `RECONCILIATION_ISSUE_DETECTED` | payments/delivery              | notifications(admin alert)                                                           | `issue:{id}`                    | entityType, entityId, severity                 |

### Ordering guarantees

Events are **not globally ordered**. Consumers must tolerate out-of-order arrival:

- `ORDER_DELIVERED` may arrive before `DELIVERY_PICKED_UP` was processed. Loyalty earning depends only on order state at processing time, re-read from the database — not on the event payload.
- Every consumer **re-reads current state** before acting. The payload is a hint, never a source of truth.

---

## 12. Background jobs

All jobs run in the worker process on BullMQ. Every job is idempotent, retryable, and observable.

### Default retry policy

| Failure class                              | Behaviour                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| Transient (network, 5xx, timeout)          | Exponential backoff with jitter: 1s, 4s, 16s, 64s, 256s — max 5 attempts |
| Permanent (4xx validation, unknown entity) | No retry; dead-letter immediately                                        |
| Financial operations                       | Retry **only** where idempotency is guaranteed by a database constraint  |
| Exhausted                                  | Move to DLQ, raise a `ReconciliationIssue` or alert, never silently drop |

### Job catalogue

| Job                         | Trigger                        | Queue           | Retries         | Idempotency                       | On permanent failure                           |
| --------------------------- | ------------------------------ | --------------- | --------------- | --------------------------------- | ---------------------------------------------- |
| `outbox.relay`              | Every 1s                       | `system`        | continuous      | `dispatched_at` marker            | Alert; events remain in outbox                 |
| `webhook.process`           | Webhook stored                 | `webhooks`      | 5, backoff      | `webhook_events` unique           | DLQ + CRITICAL alert                           |
| `payment.verify`            | Post-redirect / reconciliation | `payments`      | 5               | Provider fetch is read-only       | Reconciliation issue                           |
| `payment.reconcile`         | Every 15 min                   | `payments`      | 3               | Read-only comparison              | Alert                                          |
| `refund.submit`             | REFUND_INITIATED               | `payments`      | 5               | `(payment_id, idempotency_key)`   | DLQ + CRITICAL alert                           |
| `delivery.dispatch`         | ORDER_READY                    | `delivery`      | 3, long backoff | `UNIQUE(order_id)`                | Mark CREATION_FAILED, alert restaurant + admin |
| `delivery.reconcile`        | Every 10 min                   | `delivery`      | 3               | Read-only                         | Reconciliation issue                           |
| `notification.send`         | Notification created           | `notifications` | 5, backoff      | `(event, recipient, channel)`     | DLQ, visible in admin                          |
| `loyalty.earn`              | ORDER_DELIVERED                | `loyalty`       | 5               | Ledger unique index               | DLQ + alert                                    |
| `loyalty.clawback`          | REFUND_COMPLETED               | `loyalty`       | 5               | Ledger unique index               | DLQ + alert                                    |
| `loyalty.expire`            | Daily 02:00 IST                | `loyalty`       | 3               | Batched, per-customer idempotent  | Alert; resumes next run                        |
| `referral.qualify`          | ORDER_DELIVERED                | `referrals`     | 5               | `UNIQUE(qualifying_order_id)`     | DLQ + alert                                    |
| `promotion.release_expired` | Every 5 min                    | `promotions`    | 3               | Status transition guarded         | Alert                                          |
| `order.expire_unpaid`       | Every 5 min                    | `ordering`      | 3               | State machine guard               | Alert                                          |
| `analytics.rollup_daily`    | Daily 01:00 IST                | `analytics`     | 3               | Upsert on `(restaurant_id, date)` | Alert; safe to re-run                          |
| `rating.recompute`          | REVIEW_* events, debounced     | `analytics`     | 3               | Full recompute from source        | Alert                                          |
| `cart.cleanup`              | Daily                          | `system`        | 1               | Delete-by-age                     | Log only                                       |
| `session.cleanup`           | Daily                          | `system`        | 1               | Delete expired                    | Log only                                       |
| `search.refresh`            | Menu/restaurant change         | `system`        | 3               | Generated columns; recompute safe | Log                                            |
| `dlq.monitor`               | Every 5 min                    | `system`        | —               | Read-only                         | Alert if DLQ non-empty                         |

### Worker safety

- The worker runs as a **separate process** from the API so a slow job never consumes request capacity.
- Graceful shutdown: stop accepting new jobs, let in-flight jobs finish (30s grace), then exit. Never kill a worker mid-financial-operation.
- Concurrency is per-queue and bounded. `payments` and `delivery` run at low concurrency to respect provider rate limits.
- Every job logs start, completion, duration, and correlation ID.
- Jobs touching money **re-read state and re-check preconditions** before acting; they never trust the payload alone.

### Queue monitoring thresholds

| Metric                 | Warning | Critical |
| ---------------------- | ------- | -------- |
| `webhooks` depth       | > 50    | > 200    |
| `payments` depth       | > 20    | > 100    |
| `notifications` depth  | > 500   | > 2000   |
| Any DLQ                | ≥ 1     | ≥ 10     |
| Oldest waiting job age | > 2 min | > 10 min |
