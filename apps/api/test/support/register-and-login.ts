import request from 'supertest';
import type { TestApp } from './create-test-app.js';

export interface RegisteredUser {
  userId: string;
  email: string;
  cookie: string;
}

function rawSetCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** `Cookie:` header combining the CSRF cookie with an optional session cookie — the two must travel together. */
export function withCsrf(ctx: TestApp, sessionCookie = ''): string {
  return sessionCookie ? `${ctx.csrfCookie}; ${sessionCookie}` : ctx.csrfCookie;
}

/** Wraps a mutating request with the CSRF cookie + header pairing every state-changing call needs (docs/09-security.md §15.7). */
export function mutate(
  ctx: TestApp,
  method: 'post' | 'patch' | 'delete' | 'put',
  path: string,
  sessionCookie = '',
): request.Test {
  return request(ctx.app.getHttpServer())
    [method](path)
    .set('Cookie', withCsrf(ctx, sessionCookie))
    .set('X-CSRF-Token', ctx.csrfToken);
}

/** GET requests are never CSRF-checked, but may still need a session cookie. */
export function get(ctx: TestApp, path: string, sessionCookie = ''): request.Test {
  const req = request(ctx.app.getHttpServer()).get(path);
  return sessionCookie ? req.set('Cookie', sessionCookie) : req;
}

/**
 * Full register → verify → login flow via real HTTP, shared across
 * every Phase 4+ e2e suite that needs an authenticated principal but
 * isn't itself testing the auth flow (that's auth.e2e.test.ts's job).
 */
export async function registerAndLogin(
  ctx: TestApp,
  overrides: { email?: string; fullName?: string; password?: string } = {},
): Promise<RegisteredUser> {
  const email = overrides.email ?? `owner-${Math.random().toString(36).slice(2)}@spiceroute.test`;
  const fullName = overrides.fullName ?? 'Priya Owner';
  const password = overrides.password ?? 'correct-horse-battery-staple';

  await mutate(ctx, 'post', '/api/v1/auth/register')
    .send({ email, fullName, password })
    .expect(200);

  const code = ctx.notifier.emailVerificationCodes.get(email);
  if (!code) throw new Error('verification code was not captured by the fake notifier');
  await mutate(ctx, 'post', '/api/v1/auth/otp/verify')
    .send({ identifier: email, purpose: 'EMAIL_VERIFICATION', code })
    .expect(200);

  const loginRes = await mutate(ctx, 'post', '/api/v1/auth/login')
    .send({ email, password })
    .expect(200);
  const userId = ctx.db.users.find((u) => u.email === email)!.id;
  const cookie = rawSetCookies(loginRes)
    .map((c) => c.split(';')[0])
    .join('; ');

  return { userId, email, cookie };
}
