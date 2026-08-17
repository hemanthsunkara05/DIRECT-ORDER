# 9. Authorization Matrix

## 9.1 Model

Authorization answers three independent questions. All three must pass.

1. **Authentication** — who is this principal?
2. **Role capability** — does this role hold this permission?
3. **Resource scope** — does this specific resource belong to this principal's tenant or ownership?

Passing 1 and 2 while skipping 3 is the IDOR bug class. Passing 1 and 3 while skipping 2 is the privilege-escalation class. Both are treated as CRITICAL defects.

### Principals

| Principal            | Source of identity                      | Notes                                                      |
| -------------------- | --------------------------------------- | ---------------------------------------------------------- |
| `GUEST`              | Signed guest token or none              | Public reads, guest checkout, own-order tracking by token  |
| `CUSTOMER`           | Session, `customers.user_id`            | Owns orders, addresses, loyalty, referrals, reviews, cases |
| `RESTAURANT_STAFF`   | Session + ACTIVE `restaurant_staff` row | Tenant-scoped, role STAFF                                  |
| `RESTAURANT_MANAGER` | Same, role MANAGER                      | Tenant-scoped                                              |
| `RESTAURANT_OWNER`   | Same, role OWNER                        | Tenant-scoped                                              |
| `SUPPORT`            | Session + `admin_users` role SUPPORT    | Cross-tenant read, narrow write                            |
| `ADMIN_OPERATIONS`   | `admin_users` role OPERATIONS           | Platform operations                                        |
| `ADMIN_FINANCE`      | `admin_users` role FINANCE              | Payments and refunds                                       |
| `SUPER_ADMIN`        | `admin_users` role SUPER_ADMIN          | Full, MFA mandatory                                        |
| `SYSTEM`             | Internal worker                         | No HTTP surface                                            |

**Restaurant roles are ordered** (OWNER > MANAGER > STAFF) — a permission granted to STAFF is implicitly held by MANAGER and OWNER. **Admin roles are not ordered**; SUPER_ADMIN is a superset by explicit grant, the rest are disjoint capability sets. This prevents a SUPPORT agent from inheriting FINANCE refund powers by accident.

### Implementation

```ts
@Permissions('orders:accept')          // role capability
@TenantScoped('restaurant')            // resource scope, resolved from membership
@Post('orders/:id/accept')
```

The guard resolves the tenant from the authenticated principal, loads the resource, and compares. It never reads a tenant identifier from the request body or path. A resource outside the principal's tenant produces **404**, not 403.

---

## 9.2 Permission catalogue

| Permission                | STAFF | MANAGER | OWNER | SUPPORT | OPS | FINANCE | SUPER |
| ------------------------- | :---: | :-----: | :---: | :-----: | :-: | :-----: | :---: |
| `restaurant:read`         |   ✓   |    ✓    |   ✓   |    ✓    |  ✓  |    ✓    |   ✓   |
| `restaurant:update`       |       |    ✓    |   ✓   |         |     |         |   ✓   |
| `restaurant:branding`     |       |    ✓    |   ✓   |         |     |         |   ✓   |
| `restaurant:settings`     |       |    ✓    |   ✓   |         |     |         |   ✓   |
| `restaurant:hours`        |       |    ✓    |   ✓   |         |     |         |   ✓   |
| `restaurant:availability` |   ✓   |    ✓    |   ✓   |         |     |         |   ✓   |
| `restaurant:approve`      |       |         |       |         |  ✓  |         |   ✓   |
| `restaurant:reject`       |       |         |       |         |  ✓  |         |   ✓   |
| `restaurant:suspend`      |       |         |       |         |  ✓  |         |   ✓   |
| `menu:read`               |   ✓   |    ✓    |   ✓   |    ✓    |  ✓  |         |   ✓   |
| `menu:write`              |       |    ✓    |   ✓   |         |     |         |   ✓   |
| `menu:availability`       |   ✓   |    ✓    |   ✓   |         |     |         |   ✓   |
| `orders:read`             |   ✓   |    ✓    |   ✓   |    ✓    |  ✓  |    ✓    |   ✓   |
| `orders:accept`           |   ✓   |    ✓    |   ✓   |         |     |         |       |
| `orders:reject`           |   ✓   |    ✓    |   ✓   |         |     |         |       |
| `orders:transition`       |   ✓   |    ✓    |   ✓   |         |     |         |       |
| `orders:cancel`           |       |         |       |         |  ✓  |         |   ✓   |
| `payments:read`           |       |    ✓    |   ✓   |    ✓    |  ✓  |    ✓    |   ✓   |
| `payments:refund`         |       |         |       |         |     |    ✓    |   ✓   |
| `payments:reconcile`      |       |         |       |         |     |    ✓    |   ✓   |
| `delivery:read`           |   ✓   |    ✓    |   ✓   |    ✓    |  ✓  |         |   ✓   |
| `delivery:redispatch`     |       |         |       |         |  ✓  |         |   ✓   |
| `staff:read`              |       |    ✓    |   ✓   |         |  ✓  |         |   ✓   |
| `staff:invite`            |       |         |   ✓   |         |     |         |   ✓   |
| `staff:role_change`       |       |         |   ✓   |         |     |         |   ✓   |
| `staff:disable`           |       |         |   ✓   |         |     |         |   ✓   |
| `promotions:read`         |       |    ✓    |   ✓   |    ✓    |  ✓  |         |   ✓   |
| `promotions:write`        |       |    ✓    |   ✓   |         |     |         |   ✓   |
| `promotions:platform`     |       |         |       |         |  ✓  |         |   ✓   |
| `reviews:read`            |   ✓   |    ✓    |   ✓   |    ✓    |  ✓  |         |   ✓   |
| `reviews:respond`         |       |    ✓    |   ✓   |         |     |         |   ✓   |
| `reviews:moderate`        |       |         |       |         |  ✓  |         |   ✓   |
| `loyalty:read`            |       |         |       |    ✓    |  ✓  |    ✓    |   ✓   |
| `loyalty:adjust`          |       |         |       |         |     |         |   ✓   |
| `support:read`            |       |    ✓    |   ✓   |    ✓    |  ✓  |         |   ✓   |
| `support:write`           |       |    ✓    |   ✓   |    ✓    |  ✓  |         |   ✓   |
| `support:internal_notes`  |       |         |       |    ✓    |  ✓  |    ✓    |   ✓   |
| `support:assign`          |       |         |       |    ✓    |  ✓  |         |   ✓   |
| `analytics:restaurant`    |       |    ✓    |   ✓   |         |  ✓  |         |   ✓   |
| `analytics:platform`      |       |         |       |         |  ✓  |    ✓    |   ✓   |
| `users:read`              |       |         |       |    ✓    |  ✓  |         |   ✓   |
| `users:disable`           |       |         |       |         |     |         |   ✓   |
| `admin:role_manage`       |       |         |       |         |     |         |   ✓   |
| `audit:read`              |       |         |       |         |     |         |   ✓   |

Restaurant permissions are always **additionally** tenant-scoped: `menu:write` permits writing _this restaurant's_ menu only.

---

## 9.3 Ownership rules

| Resource                 | Ownership check                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Order (customer view)    | `order.customer_id = principal.customer_id`, or a valid signed order-access token          |
| Order (restaurant view)  | `order.restaurant_id = principal.restaurant_id`                                            |
| Address                  | `address.customer_id = principal.customer_id`                                              |
| Loyalty ledger           | `ledger.customer_id = principal.customer_id`                                               |
| Referral                 | principal is referrer or referred party                                                    |
| Review (write)           | `order.customer_id = principal.customer_id` AND order DELIVERED AND no existing review     |
| Review response          | `review.restaurant_id = principal.restaurant_id`                                           |
| Support case             | reporter is the principal, or principal is SUPPORT+                                        |
| Support INTERNAL message | `support:internal_notes` only — **never** returned to customer or restaurant               |
| Notification             | `recipient_type`/`recipient_id` match the principal                                        |
| Menu item                | `item.restaurant_id = principal.restaurant_id`                                             |
| Promotion                | platform promotions require `promotions:platform`; restaurant promotions are tenant-scoped |

### Guest order access

Guests receive a signed, expiring token in the confirmation URL: HMAC over `orderId + orderNumber + issuedAt`, 30-day expiry, single-order scope. Knowing an order number alone grants nothing.

---

## 9.4 Escalation guards

These must be explicitly tested — each represents a plausible real attack.

| Attempt                                                        | Required outcome                                     |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| Customer sets `role` in a registration or profile body         | Field stripped by Zod; role never client-assignable  |
| Restaurant staff calls any `/admin/*` endpoint                 | 403                                                  |
| Restaurant user sends `X-Restaurant-Id` for another restaurant | 403; logged as a tenant-isolation event              |
| STAFF calls `staff:role_change` on self                        | 403                                                  |
| OWNER demotes/removes the last active OWNER                    | 409 `LAST_OWNER`                                     |
| SUPPORT agent issues a refund                                  | 403 — refund needs `payments:refund`                 |
| SUPPORT agent adjusts loyalty balance                          | 403 — SUPER_ADMIN only                               |
| Admin attempts to write to `/admin/audit-logs`                 | 404 — no such route exists                           |
| Admin moves a DELIVERED order to PREPARING                     | 409 — no override path exists                        |
| Disabled staff uses an unexpired access token                  | Rejected at guard: membership re-checked per request |
| Customer requests another customer's order                     | 404                                                  |
| Customer supplies another customer's `customerId` in checkout  | Ignored; derived from session or guest token         |
| Restaurant reads another restaurant's reviews/orders/menu      | 404                                                  |
| Guest token from order A used for order B                      | 401                                                  |

**Membership and status are re-verified on every request**, not trusted from JWT claims. A staff member disabled 30 seconds ago must not act on a token minted a minute ago. The access token carries identity; it does not carry authority.
