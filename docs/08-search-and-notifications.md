# 13–14. Search and Notifications

# 13. Search and Discovery

## 13.1 Scope

Two distinct surfaces, frequently conflated — keep them separate:

| Surface | Scope | Status |
|---|---|---|
| **In-restaurant menu search** | Items within one restaurant, from its ordering page | **Ship in Phase 7.** Directly serves Layer 1 |
| **Cross-restaurant discovery** | Restaurants and items across the platform | **Build, flag off.** Enabling it launches Layer 2 — see AMB-1 |
| **Admin search** | Restaurants, orders, users, payments | Ship in Phase 11. Always available to admins |

The discovery code is written so that flipping `DISCOVERY_ENABLED` is a product decision, not an engineering project.

## 13.2 Implementation

PostgreSQL full-text search with `tsvector` generated columns plus `pg_trgm` for typo tolerance. No external search engine — see the migration triggers in the stack rationale.

```sql
-- Menu item search within a restaurant
SELECT id, name, description, price_minor, is_available
FROM menu_items
WHERE restaurant_id = $1
  AND archived_at IS NULL AND is_active = true
  AND (search_vector @@ websearch_to_tsquery('simple', $2)
       OR name % $2)                       -- trigram similarity, typo tolerance
ORDER BY ts_rank(search_vector, websearch_to_tsquery('simple', $2)) DESC,
         similarity(name, $2) DESC,
         display_order ASC
LIMIT $3;
```

Use the `simple` dictionary rather than `english`: menu content is largely transliterated Indian-language terms ("biryani", "dosa", "paneer") that English stemming corrupts. Trigram similarity handles the real-world spelling variance ("biriyani" / "biryani" / "briyani") without a hand-maintained synonym list.

## 13.3 Query handling

| Concern | Treatment |
|---|---|
| Normalisation | Trim, collapse whitespace, casefold, Unicode NFC. Do not strip diacritics — they carry meaning |
| Minimum length | 2 characters; shorter returns empty rather than scanning |
| Maximum length | 100 characters, truncated |
| Injection | `websearch_to_tsquery` with a parameterised value. Never string-concatenate a query |
| Empty result | Explicit empty state with a next action, never a broken page |

## 13.4 Filters and sorting

| Filter | Source |
|---|---|
| `openNow` | **`isAcceptingOrders()`** — the same authority as the restaurant page (BR-142) |
| `rating` | `restaurants.rating_avg`, published reviews only |
| `priceRange` | Aggregated item price band |
| `dietary` | `menu_items.dietary_tag` |
| `hasOffers` | Live promotion validation, not merely "a promotion row exists" |
| `distance` | Haversine against restaurant coordinates |

Sorting: `RELEVANCE` (default), `RATING`, `DISTANCE`, `POPULARITY`, `PRICE`.

## 13.5 Ranking

Deterministic and documented. Identical input and state always produce identical order.

```
score = 0.40 × relevance          -- ts_rank normalised 0..1
      + 0.20 × rating_score       -- Bayesian-adjusted, see below
      + 0.20 × availability       -- 1.0 open, 0.3 closed
      + 0.15 × proximity          -- 1/(1 + km), 0.5 when location unknown
      + 0.05 × recent_activity    -- completed orders last 30d, log-normalised
tie-break: restaurant_id ASC      -- guarantees stable pagination
```

**Rating uses a Bayesian average**, not a raw mean:

```
rating_score = (v × R + m × C) / (v + m)
  v = review count, R = restaurant average
  m = 10 (prior weight), C = 3.8 (platform mean)
```

A raw average lets a restaurant with two 5-star reviews outrank one with two thousand 4.8-star reviews. That is misleading to customers and gameable by restaurants — the Bayesian prior fixes both.

Excluded from ranking entirely: paid placement, manual boosts without an audit record, and any signal a restaurant can self-report.

## 13.6 Visibility and security

Only restaurants with `status = ACTIVE` and completed onboarding are searchable. DRAFT, PENDING_APPROVAL, SUSPENDED, and CLOSED never appear in customer-facing results. Search responses carry only fields already public on the restaurant page.

Search results are **advisory**. Checkout revalidates availability, prices, and item state regardless of what search returned (BR-145). A stale search cache can never cause an incorrect charge.

## 13.7 Location

| Situation | Behaviour |
|---|---|
| Permission granted | Use coordinates, show approximate distance ("2.4 km") |
| Permission denied | Fall back to city selection; distance filter hidden, not broken |
| Coordinates unavailable | Proximity term uses the neutral 0.5 value |
| Precision | Round displayed distance to 0.1 km. Never expose exact customer coordinates in a response |

## 13.8 Caching and performance

Public restaurant and menu responses cache for 60s in Redis, invalidated on menu, availability, hours, or status change. Search results are **not** cached — they are already fast and staleness here is user-visible.

Targets: p95 in-restaurant menu search under 100 ms; p95 discovery search under 250 ms; autocomplete under 150 ms with 250 ms client debounce and cancellation of superseded requests.

---

# 14. Notifications

## 14.1 Pipeline

```
Domain event → NotificationEvent → resolve recipients → apply preferences
             → create Notification per (recipient, channel) → queue → adapter → provider
             → delivery status
```

Deduplication is structural: `UNIQUE (event_id, recipient_type, recipient_id, channel)`. Duplicate events cannot produce duplicate messages.

## 14.2 Channels

| Channel | Use | Provider |
|---|---|---|
| `IN_APP` | Notification centre, always created | First-party |
| `SMS` | Order status for customers, new-order alerts for restaurants | MSG91 (DLT templates required) |
| `WHATSAPP` | Richer order updates where approved | Gupshup/Interakt |
| `EMAIL` | Receipts, invitations, password reset, digests | Resend/SES |
| `PUSH` | Optional, later | Web Push |

**SMS is the reliable baseline for India.** WhatsApp Business API approval has real lead time and DLT template registration gates SMS content — both are external dependencies. Ship SMS-first; treat WhatsApp as an enhancement.

## 14.3 Categories and preferences

| Category | Disableable | Examples |
|---|---|---|
| `SECURITY` | **No** | Password changed, new device, MFA change |
| `TRANSACTIONAL` | **No** | Order placed, accepted, ready, delivered, payment, refund |
| `ACCOUNT` | Partially | Staff invitation, role change, support replies |
| `MARKETING` | **Yes, opt-in** | Promotions, re-engagement, referral nudges |

Marketing requires explicit consent (`marketing_consent_at`); account creation is not consent (BR-129). Every marketing message carries a working unsubscribe that never affects transactional delivery.

## 14.4 Notification catalogue

| Type | Recipient | Channels | Category |
|---|---|---|---|
| `ORDER_PLACED_CUSTOMER` | Customer | IN_APP, SMS | TRANSACTIONAL |
| `ORDER_PLACED_RESTAURANT` | Restaurant | IN_APP, SMS, WHATSAPP | TRANSACTIONAL |
| `ORDER_ACCEPTED` | Customer | IN_APP, SMS | TRANSACTIONAL |
| `ORDER_REJECTED` | Customer | IN_APP, SMS | TRANSACTIONAL |
| `ORDER_PREPARING` | Customer | IN_APP | TRANSACTIONAL |
| `ORDER_READY` | Customer | IN_APP, SMS | TRANSACTIONAL |
| `DELIVERY_ASSIGNED` | Customer | IN_APP, SMS | TRANSACTIONAL |
| `DELIVERY_OUT` | Customer | IN_APP, SMS | TRANSACTIONAL |
| `ORDER_DELIVERED` | Customer | IN_APP, SMS | TRANSACTIONAL |
| `PAYMENT_FAILED` | Customer | IN_APP, SMS | TRANSACTIONAL |
| `REFUND_INITIATED` | Customer | IN_APP, SMS | TRANSACTIONAL |
| `REFUND_COMPLETED` | Customer | IN_APP, SMS | TRANSACTIONAL |
| `DELIVERY_FAILED` | Restaurant + Admin | IN_APP, SMS | TRANSACTIONAL |
| `STAFF_INVITATION` | Invitee | EMAIL | ACCOUNT |
| `SUPPORT_REPLY` | Case reporter | IN_APP, EMAIL | ACCOUNT |
| `REVIEW_RECEIVED` | Restaurant | IN_APP | ACCOUNT |
| `LOYALTY_EARNED` | Customer | IN_APP | ACCOUNT |
| `REFERRAL_REWARDED` | Referrer | IN_APP, SMS | ACCOUNT |
| `REVIEW_REMINDER` | Customer | IN_APP | MARKETING |
| `PROMOTION_AVAILABLE` | Customer | IN_APP, EMAIL | MARKETING |

## 14.5 Content safety

Templates are parameterised; dynamic values are escaped. Restaurant names, menu item names, and review text are untrusted input and are escaped in every channel including email HTML.

Never included in any notification: passwords, tokens, OTPs beyond the OTP message itself, full payment details, card data, delivery addresses in push previews, other customers' data, internal support notes.

Push and SMS previews appear on lock screens — keep them minimal: *"Order DO-260809-K3F2 is on the way"*, never the address or amount.

## 14.6 Reliability

Retry with exponential backoff (1s → 256s, 5 attempts), then dead-letter with the failure reason visible in the admin console. Permanent failures (invalid number, hard bounce) do not retry; they mark the channel unusable for that recipient and fall back to `IN_APP`.

**Notification failure never affects business state (BR-126).** If MSG91 is down, orders are still placed, paid, accepted, and delivered — customers simply see updates in the notification centre and receive SMS once the provider recovers.

## 14.7 Notification centre

Cursor-paginated list, unread badge served by the partial index (§6.3), idempotent mark-read and mark-all-read. Deep links from a notification still enforce full authorization at the destination — a notification is never an authorization bypass (BR-148).
