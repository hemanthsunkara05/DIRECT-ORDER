import { createHmac } from 'node:crypto';

/**
 * Pseudonymises a client IP before it is persisted (Session.ipHash,
 * AuditLog.ipHash — docs/09-security.md §15.9/§15.10: raw IPs are not
 * retained). HMAC rather than plain SHA-256: IPv4 space is only ~4
 * billion addresses, trivially reversible by hashing every candidate
 * against an unkeyed digest, so a secret key is required for this to
 * mean anything. Keyed by JWT_SECRET rather than a dedicated env var —
 * a second secret would add configuration surface for no real gain,
 * since a compromise of JWT_SECRET is already a full auth compromise
 * regardless of what else it keys.
 */
export function hashIp(secret: string, ip: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}
