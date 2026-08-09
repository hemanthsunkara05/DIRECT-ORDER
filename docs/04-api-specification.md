# 8. API Specification

REST over JSON. Base path `/api/v1`. REST is chosen over GraphQL because the surface is well-bounded, webhook and idempotency semantics map cleanly onto HTTP, and per-endpoint authorization is far easier to audit than a GraphQL resolver graph — auditability of authorization is a top-three requirement here.

---

## 8.1 Conventions

### Paths

```
/api/v1/public/...      no authentication (customer-facing reads, guest checkout)
/api/v1/auth/...        authentication
/api/v1/me/...          current customer, authenticated
/api/v1/restaurant/...  restaurant-scoped, tenant from authenticated membership
/api/v1/admin/...       platform admin
/api/v1/webhooks/...    external providers, signature-authenticated
```

**The restaurant tenant is never in the path or body.** `/api/v1/restaurant/orders` resolves the restaurant from the authenticated principal's membership. A path like `/api/v1/restaurants/:id/orders` invites the exact IDOR class we must prevent (INV-5). Users belonging to multiple restaurants send an `X-Restaurant-Id` header, which is **validated against membership** on every request.

### Response envelope

```jsonc
// Success
{ "data": { ... }, "meta": { "requestId": "..." } }

// Paginated
{ "data": [ ... ],
  "meta": { "requestId": "...", "pagination": { "nextCursor": "...", "hasMore": true, "limit": 20 } } }

// Error
{ "error": { "code": "PRICE_CHANGED",
             "message": "Item prices changed. Please review your cart.",
             "details": [ { "field": "items[1].price", "was": 25000, "now": 27000 } ],
             "requestId": "01J..." } }
```

`code` is a stable machine-readable identifier — clients branch on it, never on `message`. `message` is safe for display. `details` is structured, never a stack trace. Production responses never contain stack traces, SQL, or file paths.

### Status codes

| Code | Use |
|---|---|
| 200 | Success; also idempotent replay of an already-applied operation |
| 201 | Resource created |
| 400 | Malformed request |
| 401 | Missing/invalid authentication |
| 403 | Authenticated but not permitted — **also returned for cross-tenant access** |
| 404 | Not found, or exists but is not visible to this principal |
| 409 | State conflict (illegal transition, duplicate, price changed) |
| 422 | Validation failed |
| 429 | Rate limited (`Retry-After` header required) |
| 500 | Unexpected — logged with correlation ID, opaque to client |
| 503 | Dependency unavailable |

**403 vs 404 for cross-tenant access:** return **404**. Returning 403 confirms the resource exists, which leaks tenant structure. Log it internally as a tenant-isolation event.

### Pagination

Cursor-based for all time-ordered lists (orders, notifications, ledger, audit). Offset pagination only for small bounded admin lists. `limit` default 20, maximum 100 — enforced server-side; a client asking for 10,000 gets 100.

### Idempotency

Any endpoint that creates a financial or externally-visible effect **requires** an `Idempotency-Key` header (client-generated UUID). The key is stored with the created resource under a unique constraint. A replay returns the **original response** with `200`, never a duplicate resource.

Required on: checkout, payment intent creation, refunds, order state transitions, delivery dispatch, loyalty redemption, review submission.

### Validation

Every request body, query param, and path param is parsed by a Zod schema at the boundary. Unknown fields are **stripped, not merged** — this is the structural defence against mass assignment. A handler never receives an unvalidated object.

---

## 8.2 Authentication

| Method | Path | Auth | Purpose | Notes |
|---|---|---|---|---|
| POST | `/auth/register` | — | Restaurant owner registration | Rate limited 5/hr/IP. Generic response to avoid account enumeration |
| POST | `/auth/login` | — | Email + password login | Rate limited 10/15min/IP + per-account backoff. Generic failure message |
| POST | `/auth/logout` | Session | Revoke session | Idempotent |
| POST | `/auth/refresh` | Refresh cookie | Rotate tokens | Reuse of a rotated token revokes the whole family |
| POST | `/auth/mfa/verify` | Partial session | TOTP verification | Required for admins |
| POST | `/auth/password/forgot` | — | Request reset | Always 200 regardless of account existence |
| POST | `/auth/password/reset` | Reset token | Complete reset | Single-use token; revokes all sessions |
| POST | `/auth/otp/request` | — | Customer OTP | Rate limited per phone and IP |
| POST | `/auth/otp/verify` | — | Customer OTP login | Max 5 attempts, then invalidate |
| GET | `/auth/me` | Session | Current principal | Returns id, name, roles, restaurant memberships, onboarding state. **Never** password hash, tokens, or secrets |
| POST | `/auth/invitations/accept` | — | Accept staff invitation | Single-use token |

---

## 8.3 Public (customer-facing, unauthenticated)

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/public/restaurants/:slug` | Restaurant profile + branding + availability | Cached 60s. Returns only public fields |
| GET | `/public/restaurants/:slug/menu` | Categories with available items | Cached 60s, invalidated on menu change |
| GET | `/public/restaurants/:slug/reviews` | Published reviews, paginated | Display name only, never contact details |
| POST | `/public/carts` | Create/replace server cart | Returns `cartId` + guest token |
| POST | `/public/carts/:id/validate` | Revalidate against live data | Returns per-item issues |
| POST | `/public/checkout/quote` | **Authoritative pricing** | Body: cart, address, coupon, loyalty intent. Returns full breakdown |
| POST | `/public/checkout` | Create order + payment intent | **Idempotency-Key required** |
| GET | `/public/orders/:orderNumber` | Order tracking | Requires `?token=` access token or an owning session |
| POST | `/public/orders/:orderNumber/verify-payment` | Trigger server-side verification | Never trusts client status; fetches from provider |
| GET | `/public/search` | Search | **Feature-flagged**, see AMB-1 |

### Public response shape — what must never appear

The `/public/restaurants/:slug` response is the highest-risk leak surface. Explicitly excluded: staff, internal user IDs, settings beyond public ones, payment configuration, provider credentials, financial aggregates, audit data, other customers' data, unpublished/archived menu items.

### POST /public/checkout — the critical endpoint

```jsonc
// Request
{
  "cartId": "01J...",
  "customer": { "name": "...", "phone": "+91...", "email": "..." },
  "deliveryAddress": { "line1": "...", "locality": "...", "city": "...",
                       "postalCode": "...", "latitude": 12.97, "longitude": 77.59 },
  "couponCode": "WELCOME50",          // optional
  "redeemLoyaltyPoints": 200,          // optional, intent only
  "expectedTotalMinor": 45000          // optional; if sent and mismatched -> 409
}
```

Server sequence — this order is mandatory:

1. Load cart; verify it belongs to the caller (session or guest token).
2. Load restaurant; call `isAcceptingOrders()`. Not accepting → `409 RESTAURANT_UNAVAILABLE`.
3. Load every menu item **fresh from the database**. Missing/archived/unavailable → `409 ITEM_UNAVAILABLE` listing the items.
4. Compare live prices with `unit_price_minor_at_add`. Any change → `409 PRICE_CHANGED` with old/new per item. **Do not silently reprice.**
5. Validate quantities and `min_order_amount`.
6. Validate and **reserve** the coupon (locked count, §7.7).
7. Validate and **reserve** loyalty points (lock account row).
8. Compute the total through the pricing engine. This value is authoritative.
9. If `expectedTotalMinor` was sent and differs → `409 TOTAL_MISMATCH`, release reservations.
10. In one transaction: create Order (PENDING_PAYMENT) + OrderItems (snapshots) + Payment (CREATED) + reservations + status history.
11. Create the provider payment order.
12. Return order number, payable total, breakdown, and provider handles.

**Never** accept a client-supplied price, discount, or total as authoritative. `expectedTotalMinor` exists solely to detect drift and abort — it is never used to charge.

Errors: `CART_EMPTY`, `CART_NOT_FOUND`, `RESTAURANT_UNAVAILABLE`, `ITEM_UNAVAILABLE`, `PRICE_CHANGED`, `MIN_ORDER_NOT_MET`, `INVALID_ADDRESS`, `DELIVERY_AREA_UNSUPPORTED`, `COUPON_INVALID`, `COUPON_EXHAUSTED`, `INSUFFICIENT_LOYALTY_POINTS`, `TOTAL_MISMATCH`.

---

## 8.4 Customer (authenticated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/me` | Profile |
| PATCH | `/me` | Update profile |
| GET/POST | `/me/addresses` | List / create address |
| PATCH/DELETE | `/me/addresses/:id` | Update / archive — ownership enforced |
| GET | `/me/orders` | Order history, cursor-paginated |
| GET | `/me/orders/:orderNumber` | Order detail — 404 if not owned |
| GET | `/me/loyalty` | Balance + summary |
| GET | `/me/loyalty/ledger` | Paginated ledger |
| GET | `/me/referrals` | Code, link, status list — **no PII about referred people** |
| GET | `/me/notifications` | Notification centre |
| GET | `/me/notifications/unread-count` | Badge count |
| POST | `/me/notifications/:id/read` | Idempotent |
| POST | `/me/notifications/read-all` | Idempotent |
| GET/PATCH | `/me/notification-preferences` | Preferences — transactional/security not disableable |
| GET/POST | `/me/support/cases` | List / create case |
| POST | `/me/support/cases/:id/messages` | Reply — PUBLIC visibility only |
| POST | `/me/reviews` | Submit review — Idempotency-Key required |

---

## 8.5 Restaurant (tenant-scoped)

Every endpoint resolves the tenant from the authenticated membership. All return 404 for out-of-tenant resources.

| Method | Path | Min role | Purpose |
|---|---|---|---|
| GET/PATCH | `/restaurant/profile` | MANAGER | Profile |
| GET/PATCH | `/restaurant/branding` | MANAGER | Branding |
| GET/PATCH | `/restaurant/settings` | MANAGER | Settings |
| GET/PUT | `/restaurant/hours` | MANAGER | Operating hours |
| POST | `/restaurant/closures` | MANAGER | Temporary closure |
| PATCH | `/restaurant/availability` | STAFF | Toggle `ordering_enabled` — cannot override suspension |
| GET/POST | `/restaurant/menu/categories` | MANAGER | Categories |
| PATCH/DELETE | `/restaurant/menu/categories/:id` | MANAGER | Update / archive |
| POST | `/restaurant/menu/categories/reorder` | MANAGER | Bulk reorder, transactional |
| GET/POST | `/restaurant/menu/items` | MANAGER | Items |
| PATCH/DELETE | `/restaurant/menu/items/:id` | MANAGER | Update / archive |
| PATCH | `/restaurant/menu/items/:id/availability` | **STAFF** | Toggle availability — the one menu action kitchen staff need |
| POST | `/restaurant/menu/items/reorder` | MANAGER | Bulk reorder |
| POST | `/restaurant/uploads/presign` | MANAGER | Presigned image upload |
| GET | `/restaurant/orders` | STAFF | Order queue — filter, cursor-paginated |
| GET | `/restaurant/orders/stream` | STAFF | **SSE** live order feed |
| GET | `/restaurant/orders/:id` | STAFF | Detail |
| POST | `/restaurant/orders/:id/accept` | STAFF | Idempotency-Key required |
| POST | `/restaurant/orders/:id/reject` | STAFF | Reason required; triggers refund |
| POST | `/restaurant/orders/:id/preparing` | STAFF | — |
| POST | `/restaurant/orders/:id/ready` | STAFF | Triggers delivery dispatch |
| GET | `/restaurant/staff` | MANAGER | List |
| POST | `/restaurant/staff/invitations` | OWNER | Invite |
| PATCH | `/restaurant/staff/:id/role` | OWNER | Change role — cannot demote last owner |
| DELETE | `/restaurant/staff/:id` | OWNER | Disable — revokes sessions |
| GET | `/restaurant/reviews` | MANAGER | Own reviews |
| POST | `/restaurant/reviews/:id/response` | MANAGER | Respond |
| GET/POST | `/restaurant/promotions` | MANAGER | Own promotions only |
| GET | `/restaurant/analytics/overview` | MANAGER | Own metrics only |
| GET/POST | `/restaurant/support/cases` | MANAGER | Own cases |

### GET /restaurant/orders/stream (SSE)

Server-Sent Events, chosen over WebSockets: the traffic is one-directional server→client, SSE reconnects automatically, and it survives proxies without special handling.

**SSE is a latency optimisation, never the source of truth.** On connect or reconnect the client sends `Last-Event-ID`; the server replays missed events from the database. If the stream is unavailable the dashboard falls back to polling every 15s. A restaurant must never miss a paid order because a connection dropped.

---

## 8.6 Payments, refunds, delivery

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/public/payments/:paymentId/verify` | Guest token / session | Server-side verification after redirect |
| GET | `/restaurant/orders/:id/payment` | STAFF | Payment status + fee breakdown. Never provider secrets |
| POST | `/admin/payments/:id/refunds` | ADMIN (FINANCE/SUPER) | Manual refund — Idempotency-Key required |
| GET | `/admin/payments/reconciliation` | ADMIN | Open mismatches |
| POST | `/admin/orders/:id/delivery/redispatch` | ADMIN | Controlled retry |

### Webhooks

| Method | Path | Auth |
|---|---|---|
| POST | `/webhooks/payments/razorpay` | HMAC signature |
| POST | `/webhooks/delivery/:provider` | Provider-specific signature |

Contract, in order, no exceptions:

1. Read the **raw body** — signature verification must run on raw bytes, before any JSON parsing or middleware transformation.
2. Verify signature. Invalid → `401`, log a security event, **do not process**.
3. Insert into `webhook_events` with `ON CONFLICT DO NOTHING`. Zero rows → duplicate → return `200` and stop.
4. Enqueue for async processing.
5. Return `200` within 5 seconds.

Processing happens in the worker. A processing failure is retried from the stored event; it never causes a non-2xx response, because that would make the provider redeliver an event we already hold.

---

## 8.7 Admin

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/admin/overview` | Any admin | Platform metrics from rollups |
| GET | `/admin/restaurants` | OPERATIONS+ | Search / filter |
| POST | `/admin/restaurants/:id/approve` | OPERATIONS+ | Approve onboarding |
| POST | `/admin/restaurants/:id/suspend` | OPERATIONS+ | Reason required, audited |
| POST | `/admin/restaurants/:id/reinstate` | OPERATIONS+ | Audited |
| GET | `/admin/users` | OPERATIONS+ | Search — never returns hashes |
| POST | `/admin/users/:id/disable` | SUPER_ADMIN | Revokes sessions |
| GET | `/admin/orders` | Any admin | Cross-tenant search |
| POST | `/admin/orders/:id/cancel` | OPERATIONS+ | Reason required; goes through the state machine |
| GET | `/admin/payments` | FINANCE+ | Masked provider references |
| GET | `/admin/refunds` | FINANCE+ | List |
| GET | `/admin/deliveries` | OPERATIONS+ | List + failures |
| GET | `/admin/notifications` | OPERATIONS+ | Delivery log + DLQ |
| POST | `/admin/notifications/:id/retry` | OPERATIONS+ | Idempotent |
| GET | `/admin/reviews` | OPERATIONS+ | Moderation queue |
| POST | `/admin/reviews/:id/moderate` | OPERATIONS+ | Reason required, audited |
| GET/POST | `/admin/promotions` | OPERATIONS+ | Platform promotions |
| GET | `/admin/loyalty/:customerId` | SUPPORT+ | Balance + ledger |
| POST | `/admin/loyalty/:customerId/adjust` | SUPER_ADMIN | Reason required; **writes a ledger entry**, never mutates balance |
| GET | `/admin/support/cases` | SUPPORT+ | Queue |
| POST | `/admin/support/cases/:id/assign` | SUPPORT+ | Assign |
| POST | `/admin/support/cases/:id/messages` | SUPPORT+ | INTERNAL or PUBLIC |
| GET | `/admin/audit-logs` | SUPER_ADMIN | Read-only. **No write endpoint exists** |
| GET | `/admin/health` | Any admin | Dependency health |

---

## 8.8 Health

| Path | Purpose |
|---|---|
| `GET /health` | Liveness — process is up. **No dependency checks**; a database blip must not cause a restart loop |
| `GET /ready` | Readiness — database and Redis reachable, migrations applied. Governs traffic routing |

---

## 8.9 Rate limits

Distributed via Redis so limits hold across instances.

| Endpoint group | Limit |
|---|---|
| Login | 10 / 15 min / IP + exponential per-account backoff |
| Registration | 5 / hour / IP |
| OTP request | 3 / 10 min / phone; 10 / hour / IP |
| Password reset | 3 / hour / identifier |
| Coupon validation | 20 / min / customer or IP |
| Referral validation | 10 / min / IP |
| Checkout | 10 / min / customer or IP |
| Public reads | 120 / min / IP |
| Search / autocomplete | 30 / min / IP |
| Review submission | 5 / hour / customer |
| Webhooks | **Not rate limited** — never drop provider events. Protected by signature verification instead |
