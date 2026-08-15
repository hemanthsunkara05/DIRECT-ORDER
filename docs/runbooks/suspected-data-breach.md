# Runbook: Suspected data breach

Covers: suspected credential compromise, unauthorized data access, a tenant-isolation failure observed in production, or a cluster of webhook-signature failures consistent with an active probe (see [webhook-failures.md](webhook-failures.md)).

## Symptoms

- A tenant-isolation rollback trigger fires (docs/10 §17.4) — one restaurant's data observed by another's session/token.
- Anomalous access patterns in `GET /admin/audit-logs` (e.g., one actor reading an unusual volume of records outside their normal scope, or reading across many `restaurantId` values).
- A report (customer, restaurant, or internal) of data that shouldn't have been visible being visible.
- A signature-failure spike on webhook endpoints inconsistent with a known secret rotation (see [webhook-failures.md](webhook-failures.md)).

## Diagnostic commands

1. `GET /admin/audit-logs?actorType=...&entityType=...&restaurantId=...` — every mutating action in this system is audit-logged; reconstruct the actual sequence of actions taken by the suspected actor/session.
2. Identify the specific account(s)/session(s) involved — `User` rows and the `session.repository.ts`-backed session store (`apps/api/src/modules/identity`) are the source of truth for who was authenticated as whom, when.
3. Confirm scope: exactly which tenant(s)/record(s) were actually exposed, not just which were theoretically reachable — the audit log gives real, not hypothetical, exposure.
4. Check whether this correlates with a recent authorization-code change (a permission-matrix or guard regression) — cross-reference against recent deploys.

## Immediate mitigation

- **Revoke sessions for the compromised/suspect account immediately.** `POST /admin/users/:id/disable` — per this codebase's own data-model invariant ("disabling revokes all sessions instead" — `User` model doc comment, `prisma/schema.prisma`), disabling a user is the direct, already-built mechanism to cut off further access without waiting for a token to expire naturally.
- If the exposure is a genuine tenant-isolation bug (not just a compromised credential): this is a code-level emergency — the fix should ship ahead of any other in-flight work, following [bad-deployment.md](bad-deployment.md)'s rollback path if it was introduced by a recent deploy, or an expedited hotfix if it's pre-existing.
- Do not restore the affected account's access, or re-enable the disabled user, until root cause is understood — re-enabling prematurely risks a repeat compromise through the same path.
- If credentials (not just a session) were likely compromised (e.g., a leaked password, a phished admin), the user must reset their password/credential on top of the session revocation — a revoked session alone does not stop a new login with the same compromised credential.

## Recovery

- Rotate any secret plausibly exposed by the breach (webhook secrets, API keys) if the breach vector could have reached them — check `apps/api`'s bundle-secret scan (`scripts/check-web-bundle-secrets.mjs`, Phase 18) didn't already rule out a frontend-bundle leak, and check whether server-side logs/error tracking (Sentry, once a DSN is configured) could have captured anything sensitive given the Pino redact-list (Phase 18) that already masks phone/email in logs.
- Notify affected parties per whatever legal/compliance obligation applies to the actual data exposed (PII vs financial data vs neither) — this is a business/legal decision, not a purely technical one, and should not be made unilaterally by whoever is running this runbook.

## Verification

- `GET /admin/audit-logs` shows no further activity from the disabled account/session post-revocation.
- If a code fix shipped: confirm via a real regression test (matching this codebase's established practice — every authorization/tenant-isolation fix in this project ships with a cross-tenant 404 test) that the specific access path is now closed.

## Escalation

- Any confirmed cross-tenant financial or PII exposure: escalate to whoever owns legal/compliance decisions before any public communication; do not self-decide notification scope.
- Any exposure involving payment data specifically: treat with the highest urgency given this system's PCI-adjacent posture (card data itself is never stored — Razorpay is the payment provider — but even metadata exposure warrants review).
