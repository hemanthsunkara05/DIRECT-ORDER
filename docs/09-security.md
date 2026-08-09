# 15. Security Architecture

Security is designed in, not added at the end. This document is the reference for Phase 18's audit, but every phase must satisfy the controls relevant to what it builds.

---

## 15.1 Threat model

### Assets, ranked by consequence of compromise

| Asset | Impact if compromised |
|---|---|
| Payment integrity | Direct financial loss, restaurant trust destroyed, potential legal exposure |
| Tenant isolation | One restaurant reads another's customers and revenue — existential for a trust-based product |
| Admin credentials | Full platform control, refund abuse, data exfiltration |
| Customer PII (phone, address) | Privacy harm, regulatory exposure, physical-safety risk |
| Loyalty and referral balances | Financial leakage through reward farming |
| Audit log integrity | Loss of forensic capability; abuse becomes undetectable |

### Actors and their plausible attacks

| Actor | Attack |
|---|---|
| Unauthenticated attacker | Enumerate orders/coupons, forge webhooks, brute-force login, scrape menus |
| Malicious customer | Manipulate prices/totals, replay payments, farm coupons and referrals, access other orders, submit XSS in reviews |
| Restaurant staff | Access another restaurant's data, escalate to owner, alter historical prices, manipulate own ratings |
| Restaurant owner | Reach platform-admin capability, view competitor data, manipulate ranking |
| Compromised admin account | Fraudulent refunds, data export, audit tampering |
| Malicious webhook sender | Forge payment success, replay events, mark unpaid orders paid |
| Compromised provider | Send malformed or hostile payloads |
| Automated bot | Credential stuffing, coupon brute-force, scraping, checkout spam |

---

## 15.2 Authentication

| Control | Implementation |
|---|---|
| Password hashing | argon2id, memory 64 MB, iterations 3, parallelism 4 |
| Password policy | Minimum 10 characters, checked against a common-password list. No forced rotation, no composition rules — both harm real-world security |
| Access token | JWT, 15-minute expiry, carries identity only. **Authority is re-derived per request** |
| Refresh token | Opaque random 256-bit, stored hashed, rotated on every use |
| Token-reuse detection | Reuse of a rotated refresh token revokes the entire session family and raises a security event |
| Cookies | `HttpOnly; Secure; SameSite=Lax; Path=/` |
| Customer auth | Phone OTP, 6 digits, 5-minute expiry, 5 attempts, hashed at rest |
| Admin MFA | TOTP, mandatory, enforced at the guard not the UI |
| Session revocation | Logout, password change, staff disable, user disable, admin action — all revoke immediately |
| Enumeration | Login, registration, password reset, and OTP request return identical responses and comparable timing regardless of account existence |
| Brute force | Per-IP rate limit plus per-account exponential backoff; lockout after 10 failures with a 15-minute window |

## 15.3 Authorization

Enforced by guards on every route, per [05-authorization-matrix.md](05-authorization-matrix.md). Three defences:

1. **Route guards** — permission and tenant scope declared per endpoint.
2. **Repository scoping** — restaurant-scoped queries require a `restaurantId` derived from the principal; no module writes raw tenant queries inline.
3. **Integration tests** — every tenant-scoped endpoint has an explicit cross-tenant test asserting 404.

Optional fourth layer for Phase 18: Postgres Row-Level Security with per-request `SET LOCAL app.current_restaurant_id`.

## 15.4 Input validation

Zod at every boundary. **Unknown fields are stripped, not merged** — the structural defence against mass assignment. `role`, `restaurantId`, `isAdmin`, `status`, and every price field are absent from client-writable schemas entirely; they are not merely ignored.

| Vector | Control |
|---|---|
| SQL injection | Parameterised queries only. Raw SQL uses `$queryRaw` with bound parameters. String-concatenated SQL is forbidden; enforce with a lint rule |
| Dynamic ORDER BY | Sort fields resolved through an allowlist map, never interpolated |
| XSS | React escapes by default. `dangerouslySetInnerHTML` is banned by lint rule. Restaurant names, menu text, and reviews are treated as hostile |
| Mass assignment | Schema strip |
| Path traversal | Storage keys are server-generated UUIDs; client filenames never reach a path |
| Prototype pollution | Zod parsing rejects `__proto__` keys |
| Oversized payloads | 1 MB JSON body limit; 5 MB image upload limit |

## 15.5 Payment security

| Control | Implementation |
|---|---|
| Amount authority | Server-computed only; provider amount compared exactly before capture is honoured |
| Webhook signature | HMAC over the **raw** body before parsing. Constant-time comparison |
| Replay protection | `UNIQUE (provider, provider_event_id)` plus timestamp tolerance where the provider supplies one |
| Idempotency | Database constraints on orders, payments, refunds, deliveries |
| Card data | Never touches our systems — the provider's hosted flow handles it |
| Credentials | Server-side only; never in the frontend bundle, never in logs |
| State authority | Payment state changes only through the payments module, only on verified signals |
| Mismatch handling | Amount or currency mismatch raises a CRITICAL reconciliation issue and alerts; it never auto-resolves |

### Attacks that must be tested and must fail

Modify the amount in the checkout body · replace `orderId` with another customer's · forge a `payment.captured` webhook without a valid signature · replay a valid webhook · submit a refund exceeding the captured amount · submit two identical refunds concurrently · mark an unpaid order paid via any API · access another customer's order by order number without a token.

## 15.6 File upload security

Presigned uploads with server-side validation of declared content type and size, server-generated object keys (UUID + extension), and **content-based verification after upload** — the magic bytes must match the declared type. SVG uploads are rejected outright (they execute script). Menu images are public; support attachments are private with 5-minute signed URLs.

## 15.7 Transport, headers, CORS

TLS everywhere, HSTS with a one-year max-age, HTTP redirected to HTTPS.

```
Content-Security-Policy: default-src 'self'; img-src 'self' https://<cdn> data:;
  script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src https://<payment-provider>;
  connect-src 'self' https://<api>; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(self), camera=(), microphone=()
```

CORS allows an explicit origin list per environment. `Access-Control-Allow-Origin: *` with credentials is forbidden. Development origins must not survive into production configuration — assert this in a startup check.

Because authentication uses cookies, state-changing requests require CSRF protection: `SameSite=Lax` plus a double-submit token on non-GET requests from browser clients. Webhook endpoints are exempt (no cookies, signature-authenticated).

## 15.8 Secrets

Secrets live only in the platform secret store, injected as environment variables at runtime. Never in source control, Docker images, the frontend bundle, logs, URLs, error messages, or documentation.

`.env.example` contains names and formats only. CI runs secret scanning (gitleaks) on every PR. Any secret that reaches version control is treated as compromised and rotated — deleting the commit is not remediation.

Only `NEXT_PUBLIC_*` variables reach the browser; a startup assertion fails the build if any other secret name appears in the client bundle.

## 15.9 Logging and privacy

Structured JSON with correlation IDs. A field redaction list is applied at the logger level, not at call sites — call-site discipline fails eventually.

**Never logged:** passwords, tokens, refresh tokens, OTP codes, API keys, webhook secrets, card data, CVV, full delivery addresses, full phone numbers (log last 4 digits), email addresses in bulk.

**Always logged for traceability:** correlation ID, actor type and ID, route, status, duration, order/payment/delivery references.

Production errors return a safe code, message, and request ID. Stack traces, SQL, and file paths stay in internal logs.

## 15.10 Data privacy

| Data | Purpose | Retention |
|---|---|---|
| Customer name, phone, address | Order fulfilment | Order lifetime + 7 years (financial records) |
| Email | Receipts, account | Until deletion request |
| Order history | Fulfilment, support, analytics | 7 years **[requires legal confirmation]** |
| Payment references | Reconciliation | 7 years |
| Session, OTP | Authentication | 30 days / 5 minutes |
| Audit logs | Forensics, compliance | 3 years **[requires legal confirmation]** |
| Analytics events | Product analysis | 13 months |
| Support cases | Service history | 3 years |

**Third-party sharing** — minimum necessary in every case: payment provider receives amount, order reference, and customer contact; delivery provider receives pickup and dropoff addresses, customer name and phone, and order reference — never payment details; notification providers receive phone/email and message content; storage receives images only.

**Account deletion** anonymises rather than cascades: name → "Deleted Customer", phone and email → null, addresses purged. Orders, payments, and refunds are retained with the anonymised reference, because deleting financial history is both operationally and legally wrong. Audit logs are never deleted.

## 15.11 Dependencies and supply chain

Lockfiles committed. `npm audit` in CI, failing on high and critical. Dependabot for security patches. Pinned Docker base images by digest. No `postinstall` scripts from untrusted packages. Minimum-permission CI tokens; secrets unavailable to pull-request workflows from forks.

## 15.12 Security checklist per phase

Every phase must confirm before completion:

- [ ] New endpoints declare permission and tenant scope
- [ ] Cross-tenant access tests exist and pass
- [ ] Inputs validated by schema; unknown fields stripped
- [ ] No client-supplied identifiers used for authorization
- [ ] No secrets in code, logs, or client bundle
- [ ] New financial paths are idempotent by database constraint
- [ ] New state changes write audit records
- [ ] No new `dangerouslySetInnerHTML` or raw SQL concatenation
- [ ] Error responses leak no internals
