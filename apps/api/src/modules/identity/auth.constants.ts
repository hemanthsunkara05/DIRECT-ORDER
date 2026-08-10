/**
 * Shared between AuthController (sets these cookies) and AuthGuard
 * (reads them) — kept in one place so the two can never drift.
 * `HttpOnly; Secure; SameSite=Lax; Path=/` per docs/09-security.md §15.2;
 * the actual cookie options (not just the names) live in auth.controller.ts
 * next to where they're set, so the security-relevant flags stay visible
 * at the call site rather than buried in a constants file.
 */
export const ACCESS_TOKEN_COOKIE = 'do_access_token';
export const REFRESH_TOKEN_COOKIE = 'do_refresh_token';
