# 18. Testing Strategy

Coverage percentage is not the goal. **Risk coverage** is. A module with 95% coverage and no concurrency test on its money path is worse tested than one at 60% with the race conditions pinned down.

---

## 18.1 Priority order

Test effort follows consequence of failure:

1. **Financial integrity** — pricing, payments, refunds, loyalty, promotions
2. **Authorization and tenant isolation** — every protected endpoint
3. **State machines** — every legal transition, every illegal one
4. **Idempotency and concurrency** — duplicate and parallel requests
5. **External integration failure** — timeouts, duplicates, out-of-order events
6. **Core user journeys** — end to end
7. Everything else

## 18.2 Test types

| Type        | Tool                                | Scope                                                     | Speed   |
| ----------- | ----------------------------------- | --------------------------------------------------------- | ------- |
| Unit        | Vitest                              | Pure logic: pricing, state guards, validators, formatters | ms      |
| Integration | Vitest + Supertest + Testcontainers | HTTP → service → real Postgres                            | seconds |
| Contract    | Vitest                              | Provider adapters against recorded fixtures               | ms      |
| Concurrency | Vitest + parallel requests          | Races on shared resources                                 | seconds |
| E2E         | Playwright                          | Full browser journeys                                     | minutes |
| Load        | k6                                  | Staging only                                              | minutes |

**Integration tests use a real PostgreSQL via Testcontainers, never mocks.** Most of what we must prove — unique constraints, CHECK constraints, row locking, transaction isolation — exists only in the database. Mocking it tests nothing that matters here.

## 18.3 Required tests by domain

### Pricing (unit, exhaustive)

Single item · multiple items · quantities · packaging fee · delivery fee · platform fee zero and non-zero · tax · percentage discount with and without cap · fixed discount · discount exceeding subtotal (clamped) · loyalty redemption · promotion plus loyalty combined · rounding at every boundary (1 paise, 33.33%, 0.5 rounding) · **no floating point anywhere in the trace** · same input always yields identical output.

```ts
it('never produces a negative payable total', () => {
  const r = pricing.calculate({
    items: [{ priceMinor: 10000n, qty: 1 }],
    promotion: { type: 'FIXED_AMOUNT', valueMinor: 50000n },
  });
  expect(r.payableTotalMinor).toBe(0n);
  expect(r.discountMinor).toBeLessThanOrEqual(r.discountableBaseMinor);
});
```

### Checkout and orders (integration)

Successful order · empty cart · restaurant closed · restaurant suspended · item unavailable · item archived mid-checkout · **price changed mid-checkout** · below minimum order · invalid address · invalid phone · quantity over cap · **duplicate `Idempotency-Key` returns the same order** · **two concurrent identical checkouts produce exactly one order** · order snapshot unaffected by later menu price change.

### Payments (integration)

Payment created with server-computed amount · verified webhook marks captured and order PLACED · **invalid signature rejected with 401 and security event** · **duplicate webhook produces one effect** · **out-of-order webhook does not regress state** · **amount mismatch does not capture, raises CRITICAL issue** · currency mismatch same · failed payment leaves order retryable · retry reuses the same order · unknown-order webhook stored and flagged, returns 200 · frontend-claimed success without provider confirmation does not mark paid.

### Refunds (integration + concurrency)

Full refund on rejection · duplicate refund request is idempotent · **refund exceeding captured amount rejected** · **two concurrent refunds cannot exceed captured** · refund failure retryable · status only COMPLETED on provider confirmation.

### Order state machine (integration, table-driven)

Generate the full state × transition matrix. Every legal transition succeeds with correct actor; every illegal one returns 409. Explicitly: `DELIVERED → PREPARING` fails · `CANCELLED → ACCEPTED` fails · `PLACED → PREPARING` fails · **two staff accepting concurrently: one succeeds, one gets idempotent 200, exactly one refund path possible on double-reject**.

### Tenant isolation (integration — every tenant-scoped endpoint)

Write this as a **parameterised suite over the endpoint list** so a new endpoint cannot be added without an isolation test:

```ts
describe.each(TENANT_SCOPED_ENDPOINTS)('tenant isolation: %s %s', (method, path) => {
  it('returns 404 for another restaurant resource', async () => {
    const { restaurantA, restaurantB } = await seedTwoRestaurants();
    const res = await request(app)
      [method](path.replace(':id', restaurantB.resourceId))
      .set('Cookie', await sessionFor(restaurantA.owner));
    expect(res.status).toBe(404);
  });
});
```

Covering: orders, menu, categories, staff, settings, branding, promotions, reviews, analytics, support, deliveries — read **and** write.

### Authorization (integration)

Every endpoint × every principal (guest, customer, staff, manager, owner, support, ops, finance, super-admin). Assert the matrix in [05-authorization-matrix.md](05-authorization-matrix.md). Plus every escalation guard in §9.4.

### Promotions (integration + concurrency)

Valid coupon · expired · not started · inactive · below minimum · percentage cap · fixed exceeding total · **global limit: N+1 concurrent claims yield exactly N redemptions** · **per-customer limit enforced** · reservation released on payment failure · reservation confirmed on capture · first-order eligibility from delivered history · unknown code response indistinguishable from ineligible code.

### Loyalty (integration + concurrency)

Earn on delivery · **no earn on cancellation** · **duplicate delivery event awards once** · redeem within balance · redeem beyond balance rejected · **two concurrent redemptions cannot overdraw** · refund clawback proportional · ledger sum reconciles with cached balance · admin adjustment writes ledger, never mutates balance directly.

### Referrals (integration)

Valid attribution · **self-referral rejected at database level** · second referrer rejected · qualification only on DELIVERED · **duplicate qualification event rewards once** · refund invalidates and claws back · referrer sees no PII of referred customer.

### Delivery (integration)

Dispatch on ready · **"ready" twice creates one delivery** · provider timeout does not duplicate · provider rejection marks CREATION_FAILED and alerts · duplicate webhook single effect · out-of-order events handled · cross-restaurant delivery access returns 404 · provider credentials absent from all responses.

### Notifications (integration)

Created on state change · **duplicate event yields one notification per channel** · transactional preference cannot be disabled · marketing requires consent · retry on transient failure · dead-letter after cap · **provider outage does not roll back the order** · cross-user notification access returns 404.

### Reviews, support, search, analytics

Review eligibility (delivered, owned, unreviewed) · one per order under concurrency · XSS payload stored and rendered safely · restaurant cannot alter or hide reviews · aggregate matches published rows · **internal support notes never returned to customer or restaurant endpoints** · search excludes suspended restaurants · "open now" agrees with the restaurant page · analytics never mutates transactional data · rollups reconcile with source.

### Security (integration)

SQL injection in every search, filter, and sort parameter · XSS in every free-text field · mass assignment of `role`, `restaurantId`, `isAdmin`, price fields · IDOR across every resource type · rate limits enforced · invalid/expired/tampered tokens rejected · disabled staff token rejected · file upload: wrong type, spoofed MIME, oversized, SVG · webhook forgery · CORS from a disallowed origin.

## 18.4 End-to-end journeys (Playwright)

1. **Customer happy path** — open restaurant link → browse → cart → checkout → test payment → confirmation → track through delivery → review.
2. **Restaurant fulfilment** — login → receive order live → accept → preparing → ready → delivery dispatched → delivered.
3. **Restaurant onboarding** — register → verify → create restaurant → branding → hours → menu → publish → public page live.
4. **Failure recovery** — payment fails → retry → succeeds → exactly one order exists.
5. **Rejection and refund** — restaurant rejects paid order → refund initiated → customer sees refund status.
6. **Staff permissions** — owner invites staff → staff logs in → sees only permitted actions → owner disables → access revoked.
7. **Mobile** — the customer path at 375 px viewport.
8. **Accessibility** — keyboard-only completion of the customer path.

## 18.5 Concurrency test pattern

```ts
async function concurrent<T>(n: number, fn: () => Promise<T>) {
  return Promise.allSettled(Array.from({ length: n }, fn));
}

it('coupon with limit 1 survives 10 simultaneous claims', async () => {
  const promo = await seedPromotion({ usageLimitTotal: 1 });
  const results = await concurrent(10, () => checkout({ couponCode: promo.code }));
  const ok = results.filter((r) => r.status === 'fulfilled' && r.value.status === 201);
  expect(ok).toHaveLength(1);
  expect(await countRedemptions(promo.id)).toBe(1);
});
```

## 18.6 Data integrity assertions

Run after the full suite and on a schedule in production (read-only):

```sql
-- No order violates its total identity
SELECT count(*) FROM orders WHERE payable_total_minor <>
  items_subtotal_minor + packaging_fee_minor + delivery_fee_minor
  + platform_fee_minor + tax_minor - discount_minor - loyalty_discount_minor;

-- No over-refund
SELECT count(*) FROM payments WHERE refunded_minor > captured_minor;

-- No duplicate delivery per order
SELECT order_id FROM deliveries GROUP BY order_id HAVING count(*) > 1;

-- Loyalty balance matches ledger
SELECT a.customer_id FROM loyalty_accounts a
JOIN (SELECT customer_id, sum(points) s FROM loyalty_ledger GROUP BY 1) l
  ON l.customer_id = a.customer_id
WHERE a.balance_points <> l.s;

-- No order paid without a captured payment
SELECT o.id FROM orders o LEFT JOIN payments p ON p.order_id = o.id
WHERE o.status NOT IN ('PENDING_PAYMENT','PAYMENT_FAILED','EXPIRED')
  AND (p.id IS NULL OR p.captured_minor = 0);

-- No referral rewarded twice
SELECT reference_id FROM loyalty_ledger WHERE type = 'REFERRAL_REWARD'
GROUP BY reference_id HAVING count(*) > 1;
```

Every one of these must return zero rows.

## 18.7 CI gates

| Gate                                    | Blocks merge            |
| --------------------------------------- | ----------------------- |
| Typecheck, lint, format                 | Yes                     |
| Unit + integration tests                | Yes                     |
| Authorization + tenant isolation suites | Yes                     |
| Financial invariant tests               | Yes                     |
| Build (both apps)                       | Yes                     |
| Secret scan                             | Yes                     |
| `npm audit` high/critical               | Yes                     |
| E2E (main branch)                       | Yes                     |
| Load tests                              | No — staging, on demand |

**Never:** delete a failing test, weaken an assertion, or skip a suite to make CI green. A failing security or financial test is a genuine defect. If a test is flaky, fix the flakiness or the race it exposed — do not retry-loop around it.
