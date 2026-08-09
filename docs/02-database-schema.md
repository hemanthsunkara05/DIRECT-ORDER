# 6. Database Schema

PostgreSQL 16. Managed through Prisma migrations. This document specifies the constraints that carry correctness — write the Prisma schema to produce these, and add raw-SQL migrations for anything Prisma cannot express (partial indexes, CHECK constraints, generated columns, triggers).

---

## 6.1 Global conventions

| Concern      | Convention                                                  |
| ------------ | ----------------------------------------------------------- |
| Table names  | `snake_case`, plural (`order_items`)                        |
| Column names | `snake_case`                                                |
| Primary key  | `id UUID PRIMARY KEY` — UUIDv7 generated in the application |
| Foreign keys | `<entity>_id`, always with an explicit `ON DELETE` rule     |
| Timestamps   | `TIMESTAMPTZ NOT NULL DEFAULT now()`, stored UTC            |
| Money        | `BIGINT` minor units, column suffix `_minor`                |
| Currency     | `CHAR(3) NOT NULL DEFAULT 'INR'`                            |
| Enums        | Postgres native `ENUM` types                                |
| Soft delete  | `archived_at TIMESTAMPTZ NULL` — never a boolean            |
| Booleans     | `is_` / `has_` prefix                                       |

### Deletion policy

| Data                                                       | Policy                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| Orders, payments, refunds, deliveries, ledgers, audit logs | **Never deleted.** No `ON DELETE CASCADE` reaches them.         |
| Menu items, categories                                     | Archived (`archived_at`), never deleted — orders reference them |
| Restaurants, users                                         | Status change only; `ON DELETE RESTRICT` from financial tables  |
| Carts, OTP challenges, expired sessions                    | Hard-deletable by cleanup jobs                                  |

**Rule:** `ON DELETE CASCADE` is permitted only where the child is meaningless without the parent _and_ carries no financial or audit value (e.g. `cart_items` → `carts`). Everywhere else use `RESTRICT`.

---

## 6.2 Money and rounding

```sql
-- Correct
items_subtotal_minor  BIGINT NOT NULL CHECK (items_subtotal_minor >= 0),
payable_total_minor   BIGINT NOT NULL CHECK (payable_total_minor >= 0),
currency              CHAR(3) NOT NULL DEFAULT 'INR'

-- FORBIDDEN
price NUMERIC(10,2)   -- invites float conversion in the ORM layer
price FLOAT           -- never
```

**Rounding policy — apply exactly once, at the end.**

1. Compute every line total in integer paise: `unit_price_minor * quantity`. Exact, no rounding.
2. Sum to `items_subtotal_minor`. Exact.
3. Percentage discounts round **half-up** to the nearest paise, once, at the moment computed.
4. Taxes and percentage fees round **half-up**, once each.
5. Never round an intermediate sum twice.

```ts
// The only rounding helper in the codebase. Everything else uses integers.
export function percentageOf(amountMinor: bigint, percent: number): bigint {
  const scaled = amountMinor * BigInt(Math.round(percent * 100));
  return (scaled + 5000n) / 10000n; // half-up
}
```

---

## 6.3 Critical DDL

The tables below carry the constraints that make the system correct. Reproduce these exactly.

### orders

```sql
CREATE TABLE orders (
  id                     UUID PRIMARY KEY,
  order_number           TEXT NOT NULL,
  restaurant_id          UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  customer_id            UUID NOT NULL REFERENCES customers(id)   ON DELETE RESTRICT,
  status                 order_status NOT NULL,

  customer_name          TEXT NOT NULL,
  customer_phone         TEXT NOT NULL,
  delivery_address       JSONB NOT NULL,

  items_subtotal_minor   BIGINT NOT NULL CHECK (items_subtotal_minor  >= 0),
  packaging_fee_minor    BIGINT NOT NULL DEFAULT 0 CHECK (packaging_fee_minor >= 0),
  delivery_fee_minor     BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_minor  >= 0),
  platform_fee_minor     BIGINT NOT NULL DEFAULT 0 CHECK (platform_fee_minor  >= 0),
  tax_minor              BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor           >= 0),
  discount_minor         BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor      >= 0),
  loyalty_discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (loyalty_discount_minor >= 0),
  payable_total_minor    BIGINT NOT NULL CHECK (payable_total_minor >= 0),
  currency               CHAR(3) NOT NULL DEFAULT 'INR',
  pricing_breakdown      JSONB NOT NULL,

  promotion_id           UUID REFERENCES promotions(id) ON DELETE RESTRICT,
  coupon_code            TEXT,
  applied_loyalty_points INTEGER NOT NULL DEFAULT 0 CHECK (applied_loyalty_points >= 0),

  idempotency_key        TEXT NOT NULL,
  placed_at              TIMESTAMPTZ,
  accepted_at            TIMESTAMPTZ,
  ready_at               TIMESTAMPTZ,
  delivered_at           TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,
  rejection_reason       TEXT,
  cancellation_reason    TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- INV-7: totals must reconcile exactly
  CONSTRAINT order_total_consistent CHECK (
    payable_total_minor =
      items_subtotal_minor + packaging_fee_minor + delivery_fee_minor
      + platform_fee_minor + tax_minor - discount_minor - loyalty_discount_minor
  ),
  CONSTRAINT order_discount_bounded CHECK (
    discount_minor + loyalty_discount_minor
      <= items_subtotal_minor + packaging_fee_minor + delivery_fee_minor
         + platform_fee_minor + tax_minor
  )
);

CREATE UNIQUE INDEX orders_order_number_key ON orders (order_number);
CREATE UNIQUE INDEX orders_idem_key         ON orders (restaurant_id, idempotency_key);
CREATE INDEX orders_restaurant_status_idx   ON orders (restaurant_id, status, created_at DESC);
CREATE INDEX orders_restaurant_created_idx  ON orders (restaurant_id, created_at DESC);
CREATE INDEX orders_customer_created_idx    ON orders (customer_id, created_at DESC);
CREATE INDEX orders_active_idx              ON orders (restaurant_id, created_at DESC)
  WHERE status IN ('PLACED','ACCEPTED','PREPARING','READY_FOR_PICKUP','OUT_FOR_DELIVERY');
```

`order_number` format: `DO-YYMMDD-XXXXX` where `XXXXX` is base32 from a per-day sequence mixed with random bits. Sequential enough for staff to read aloud, not enumerable enough to guess another customer's order.

### order_items

```sql
CREATE TABLE order_items (
  id                        UUID PRIMARY KEY,
  order_id                  UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  menu_item_id              UUID NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
  name_snapshot             TEXT NOT NULL,
  description_snapshot      TEXT,
  unit_price_minor_snapshot BIGINT NOT NULL CHECK (unit_price_minor_snapshot > 0),
  quantity                  INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 99),
  line_total_minor          BIGINT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT line_total_correct CHECK (line_total_minor = unit_price_minor_snapshot * quantity)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
```

### payments

```sql
CREATE TABLE payments (
  id                    UUID PRIMARY KEY,
  order_id              UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider              TEXT NOT NULL,
  provider_order_id     TEXT,
  provider_payment_id   TEXT,
  status                payment_status NOT NULL,
  amount_minor          BIGINT NOT NULL CHECK (amount_minor > 0),
  captured_minor        BIGINT NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
  refunded_minor        BIGINT NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  currency              CHAR(3) NOT NULL DEFAULT 'INR',
  method                TEXT,
  failure_code          TEXT,
  failure_message       TEXT,
  idempotency_key       TEXT NOT NULL,
  reconciliation_status TEXT NOT NULL DEFAULT 'OK',
  authorized_at         TIMESTAMPTZ,
  captured_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT captured_within_amount  CHECK (captured_minor <= amount_minor),
  CONSTRAINT refund_within_captured  CHECK (refunded_minor <= captured_minor)  -- INV-6
);

CREATE UNIQUE INDEX payments_provider_payment_key ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX payments_idem_key ON payments (idempotency_key);
CREATE INDEX payments_order_idx  ON payments (order_id);
CREATE INDEX payments_recon_idx  ON payments (reconciliation_status) WHERE reconciliation_status <> 'OK';
```

### webhook_events — the idempotency anchor

```sql
CREATE TABLE webhook_events (
  id                UUID PRIMARY KEY,
  provider          TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  signature_valid   BOOLEAN NOT NULL,
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'RECEIVED',
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX webhook_events_provider_event_key
  ON webhook_events (provider, provider_event_id);
CREATE INDEX webhook_events_unprocessed_idx
  ON webhook_events (provider, received_at) WHERE status IN ('RECEIVED','FAILED');
```

**Processing contract.** Verify signature → `INSERT ... ON CONFLICT DO NOTHING` → if zero rows inserted, this is a duplicate: return 200 immediately and stop → otherwise enqueue for async processing → return 200. Never let processing failure produce a non-2xx, or the provider will retry a webhook we have already stored.

### deliveries

```sql
CREATE TABLE deliveries (
  id                    UUID PRIMARY KEY,
  order_id              UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider              TEXT NOT NULL,
  provider_delivery_id  TEXT,
  status                delivery_status NOT NULL,
  pickup_address        JSONB NOT NULL,
  dropoff_address       JSONB NOT NULL,
  courier_name          TEXT,
  courier_phone         TEXT,
  tracking_url          TEXT,
  quoted_fee_minor      BIGINT CHECK (quoted_fee_minor  >= 0),
  actual_fee_minor      BIGINT CHECK (actual_fee_minor  >= 0),
  idempotency_key       TEXT NOT NULL,
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  estimated_pickup_at   TIMESTAMPTZ,
  estimated_delivery_at TIMESTAMPTZ,
  picked_up_at          TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  cancellation_reason   TEXT,
  failure_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One delivery per order: the primary defence against duplicate dispatch
CREATE UNIQUE INDEX deliveries_order_key ON deliveries (order_id);
CREATE UNIQUE INDEX deliveries_provider_key ON deliveries (provider, provider_delivery_id)
  WHERE provider_delivery_id IS NOT NULL;
```

### promotion_redemptions — race-safe usage limits

```sql
CREATE TABLE promotion_redemptions (
  id             UUID PRIMARY KEY,
  promotion_id   UUID NOT NULL REFERENCES promotions(id) ON DELETE RESTRICT,
  customer_id    UUID NOT NULL REFERENCES customers(id)  ON DELETE RESTRICT,
  order_id       UUID REFERENCES orders(id) ON DELETE RESTRICT,
  status         TEXT NOT NULL,  -- RESERVED | CONFIRMED | RELEASED
  discount_minor BIGINT NOT NULL CHECK (discount_minor >= 0),
  reserved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ,
  confirmed_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX promo_redemption_order_key ON promotion_redemptions (promotion_id, order_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX promo_redemption_active_idx ON promotion_redemptions (promotion_id)
  WHERE status IN ('RESERVED','CONFIRMED');
CREATE INDEX promo_redemption_customer_idx ON promotion_redemptions (promotion_id, customer_id)
  WHERE status IN ('RESERVED','CONFIRMED');
```

**Enforcing a global usage limit safely.** Counting rows then inserting is a race. Instead, inside the checkout transaction:

```sql
BEGIN;
SELECT id, usage_limit_total FROM promotions WHERE id = $1 FOR UPDATE;
SELECT count(*) FROM promotion_redemptions
  WHERE promotion_id = $1 AND status IN ('RESERVED','CONFIRMED');
-- reject if count >= usage_limit_total
INSERT INTO promotion_redemptions (...) VALUES (...);
COMMIT;
```

The `FOR UPDATE` on the promotion row serialises concurrent claimants. This is the correct pattern; do not substitute an unlocked count.

### loyalty_ledger — append-only, double-award-proof

```sql
CREATE TABLE loyalty_ledger (
  id             UUID PRIMARY KEY,
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  type           loyalty_ledger_type NOT NULL,
  points         INTEGER NOT NULL,          -- signed: + credit, - debit
  reference_type TEXT,
  reference_id   UUID,
  description    TEXT,
  actor_type     TEXT NOT NULL DEFAULT 'SYSTEM',
  actor_id       UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Makes duplicate automatic awards impossible at the storage layer
CREATE UNIQUE INDEX loyalty_ledger_ref_key
  ON loyalty_ledger (type, reference_type, reference_id)
  WHERE reference_id IS NOT NULL AND type <> 'ADMIN_ADJUSTMENT';
CREATE INDEX loyalty_ledger_customer_idx ON loyalty_ledger (customer_id, created_at DESC);
```

`loyalty_accounts.balance_points` is a cache updated in the same transaction as the ledger insert. `SELECT ... FOR UPDATE` the account row before redeeming. Reconciliation compares `SUM(points)` against the cached balance and raises a `ReconciliationIssue` on mismatch — it never silently overwrites.

### referrals

```sql
CREATE TABLE referrals (
  id                    UUID PRIMARY KEY,
  referrer_customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  referred_customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  referral_code         TEXT NOT NULL,
  status                referral_status NOT NULL DEFAULT 'PENDING',
  qualifying_order_id   UUID REFERENCES orders(id) ON DELETE RESTRICT,
  attributed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  qualified_at          TIMESTAMPTZ,
  rewarded_at           TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  CONSTRAINT no_self_referral CHECK (referrer_customer_id <> referred_customer_id)
);
CREATE UNIQUE INDEX referrals_referred_key   ON referrals (referred_customer_id);
CREATE UNIQUE INDEX referrals_qualifying_key ON referrals (qualifying_order_id)
  WHERE qualifying_order_id IS NOT NULL;
```

### notifications

```sql
CREATE UNIQUE INDEX notifications_dedupe_key
  ON notifications (event_id, recipient_type, recipient_id, channel);
CREATE INDEX notifications_unread_idx
  ON notifications (recipient_type, recipient_id, created_at DESC)
  WHERE read_at IS NULL AND channel = 'IN_APP';
CREATE INDEX notifications_pending_idx
  ON notifications (status, created_at) WHERE status = 'PENDING';
```

The partial unread index makes the badge count a cheap index-only scan rather than a table scan.

### audit_logs

```sql
CREATE TABLE audit_logs (
  id             UUID PRIMARY KEY,
  actor_type     TEXT NOT NULL,
  actor_id       UUID,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      UUID,
  restaurant_id  UUID,
  before         JSONB,
  after          JSONB,
  reason         TEXT,
  correlation_id TEXT,
  ip_hash        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx     ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_actor_idx      ON audit_logs (actor_type, actor_id, created_at DESC);
CREATE INDEX audit_restaurant_idx ON audit_logs (restaurant_id, created_at DESC) WHERE restaurant_id IS NOT NULL;

-- Defence in depth: the application role cannot rewrite history
REVOKE UPDATE, DELETE ON audit_logs FROM app_user;
```

---

## 6.4 Search indexes

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE restaurants ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description,'')), 'B')
  ) STORED;
CREATE INDEX restaurants_search_idx ON restaurants USING GIN (search_vector);
CREATE INDEX restaurants_name_trgm_idx ON restaurants USING GIN (name gin_trgm_ops);

ALTER TABLE menu_items ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description,'')), 'C')
  ) STORED;
CREATE INDEX menu_items_search_idx ON menu_items USING GIN (search_vector);
CREATE INDEX menu_items_restaurant_active_idx ON menu_items (restaurant_id, category_id, display_order)
  WHERE archived_at IS NULL AND is_active = true;
```

Use the `simple` dictionary, not `english` — menu content is heavily transliterated Indian-language terms that English stemming mangles.

---

## 6.5 Tenant isolation at the data layer

Application-level scoping is the primary control, but it is one forgotten `where` clause away from a breach. Add defence in depth:

1. **Every restaurant-scoped query goes through a repository helper** that requires a `restaurantId` argument derived from the authenticated principal. No module builds raw tenant queries inline.
2. **Integration tests assert isolation** for every tenant-scoped endpoint (see testing strategy).
3. **Optional, recommended before scaling past the pilot:** Postgres Row-Level Security with a per-request `SET LOCAL app.current_restaurant_id`, as a backstop. Introduce this in Phase 18, not during initial build — it complicates early debugging.

---

## 6.6 Migration rules

- Migrations are forward-only in production. Never edit an applied migration.
- Destructive changes follow **expand → migrate → contract** across at least two deploys.
- Adding a column: nullable or with a default, never a blocking table rewrite on a large table.
- Index creation on large tables uses `CREATE INDEX CONCURRENTLY` in a standalone migration.
- Every migration is tested against a restored production-shaped dump before release.
- A migration that deletes financial data requires explicit human approval and is never automated in the deploy pipeline.
