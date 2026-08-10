import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Double-submit cookie CSRF protection (docs/09-security.md §15.7):
 * "state-changing requests require CSRF protection: SameSite=Lax plus a
 * double-submit token on non-GET requests." SameSite=Lax already blocks
 * the classic cross-site auto-submitting form POST (Lax cookies aren't
 * sent on cross-site subrequests); this is the second, independent
 * layer — a token only same-origin JavaScript can read the cookie value
 * of and echo back as a header, which a cross-site attacker cannot do
 * even though the browser would still attach the session cookies.
 *
 * Deliberately NOT persisted server-side (no session-bound token table)
 * — the whole point of double-submit is that verification is a plain
 * equality check between cookie and header, stateless and cheap.
 */
export const CSRF_COOKIE = 'do_csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Timing-safe: an attacker who can measure comparison time shouldn't be able to guess the token byte-by-byte. */
export function csrfTokensMatch(
  cookieValue: string | undefined,
  headerValue: string | undefined,
): boolean {
  if (!cookieValue || !headerValue) return false;
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(headerValue);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
