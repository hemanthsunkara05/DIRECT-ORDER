import type { Response as SupertestResponse } from 'supertest';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';

function rawSetCookies(res: SupertestResponse): string[] {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** Reduces a response's Set-Cookie headers to a single `Cookie:` value a later request can send. */
function cookieHeader(res: SupertestResponse): string {
  return rawSetCookies(res)
    .map((c) => c.split(';')[0])
    .join('; ');
}

const OWNER = {
  email: 'owner@spiceroute.test',
  fullName: 'Priya Owner',
  password: 'correct-horse-battery-staple',
};

describe('Authentication (Phase 3, e2e)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  /** Merges the CSRF cookie in with an optional session cookie — the two must travel in ONE Cookie header. */
  function withCsrf(sessionCookie = ''): string {
    return sessionCookie ? `${ctx.csrfCookie}; ${sessionCookie}` : ctx.csrfCookie;
  }

  /**
   * Every state-changing request needs both the CSRF cookie and the
   * matching X-CSRF-Token header (docs/09-security.md §15.7) — this
   * wraps that pairing so individual tests don't repeat it. `sessionCookie`
   * is merged in alongside the CSRF cookie when a request also needs an
   * established session (e.g. GET/POST while logged in).
   */
  function mutate(
    method: 'post' | 'patch' | 'delete',
    path: string,
    sessionCookie = '',
  ): request.Test {
    return request(ctx.app.getHttpServer())
      [method](path)
      .set('Cookie', withCsrf(sessionCookie))
      .set('X-CSRF-Token', ctx.csrfToken);
  }

  /** GET requests are never CSRF-checked, but may still need a session cookie. */
  function get(path: string, sessionCookie = ''): request.Test {
    const req = request(ctx.app.getHttpServer()).get(path);
    return sessionCookie ? req.set('Cookie', sessionCookie) : req;
  }

  async function registerAndVerify(overrides: Partial<typeof OWNER> = {}) {
    const input = { ...OWNER, ...overrides };
    await mutate('post', '/api/v1/auth/register').send(input).expect(200);

    const code = ctx.notifier.emailVerificationCodes.get(input.email);
    if (!code) throw new Error('verification code was not captured by the fake notifier');

    await mutate('post', '/api/v1/auth/otp/verify')
      .send({ identifier: input.email, purpose: 'EMAIL_VERIFICATION', code })
      .expect(200);

    return input;
  }

  function login(email: string, password: string) {
    return mutate('post', '/api/v1/auth/login').send({ email, password });
  }

  describe('full lifecycle (docs/14-acceptance-criteria.md, Phase 3)', () => {
    it('register → verify → login → protected route → refresh → logout → protected route now 401', async () => {
      const owner = await registerAndVerify();

      const loginRes = await login(owner.email, owner.password).expect(200);
      expect(loginRes.body.data.email).toBe(owner.email);
      const sessionCookie1 = cookieHeader(loginRes);

      const meRes = await get('/api/v1/auth/me', sessionCookie1).expect(200);
      expect(meRes.body.data.email).toBe(owner.email);

      const refreshRes = await mutate('post', '/api/v1/auth/refresh', sessionCookie1).expect(200);
      const sessionCookie2 = cookieHeader(refreshRes);
      expect(sessionCookie2).not.toBe(sessionCookie1);

      await get('/api/v1/auth/me', sessionCookie2).expect(200);

      const logoutRes = await mutate('post', '/api/v1/auth/logout', sessionCookie2).expect(200);
      // The client's cookie jar drops these — asserting the response actively
      // clears them (an empty value with an already-past Expires), not
      // merely that it omits new ones.
      const clearedCookies = rawSetCookies(logoutRes).join('; ');
      expect(clearedCookies).toMatch(/do_access_token=;.*Expires=Thu, 01 Jan 1970/);
      expect(clearedCookies).toMatch(/do_refresh_token=;.*Expires=Thu, 01 Jan 1970/);

      // A real browser now sends no session cookie at all.
      await get('/api/v1/auth/me').expect(401);
    });

    it('the previous access token stops working immediately after logout, even though it has not expired (session revoked, not just cookie-cleared)', async () => {
      const owner = await registerAndVerify();
      const loginRes = await login(owner.email, owner.password).expect(200);
      const sessionCookie = cookieHeader(loginRes);

      await mutate('post', '/api/v1/auth/logout', sessionCookie).expect(200);

      // Simulates a copy of the still-cryptographically-valid access token
      // held outside the (now-cleared) cookie jar — e.g. an attacker who
      // captured it before logout. It must be rejected because the
      // session it references is revoked, not merely because the cookie
      // is gone (docs/09-security.md §15.2, "Session revocation ... revoke immediately").
      await get('/api/v1/auth/me', sessionCookie).expect(401);
    });
  });

  describe('account enumeration resistance (docs/09-security.md §15.2)', () => {
    it('login with a wrong password and login with a non-existent account return the same status and body shape', async () => {
      await registerAndVerify();

      const wrongPassword = await login(OWNER.email, 'not-the-right-password');
      const noSuchAccount = await login(
        'nobody-registered-this@spiceroute.test',
        'whatever-password',
      );

      expect(wrongPassword.status).toBe(noSuchAccount.status);
      expect(wrongPassword.status).toBe(401);
      expect(wrongPassword.body).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: noSuchAccount.body.error.code }),
        }),
      );
      expect(wrongPassword.body.error.message).toBe(noSuchAccount.body.error.message);
    });

    it('a disabled account and a wrong password also return the identical generic response', async () => {
      const owner = await registerAndVerify();
      const user = ctx.db.users.find((u) => u.email === owner.email)!;
      user.status = 'DISABLED';

      const disabled = await login(owner.email, owner.password);
      const wrongPassword = await login('someone-else-entirely@spiceroute.test', 'whatever');

      expect(disabled.status).toBe(wrongPassword.status);
      expect(disabled.body.error.message).toBe(wrongPassword.body.error.message);
    });

    it('registering an email that already exists does not create a duplicate user and responds identically to a fresh registration', async () => {
      await registerAndVerify();
      const before = ctx.db.users.length;

      const res = await mutate('post', '/api/v1/auth/register').send(OWNER).expect(200);

      expect(ctx.db.users.length).toBe(before);
      expect(res.body.data.message).toEqual(expect.any(String));
    });

    it('password/forgot always returns 200 regardless of whether the account exists', async () => {
      await registerAndVerify();

      const known = await mutate('post', '/api/v1/auth/password/forgot')
        .send({ email: OWNER.email })
        .expect(200);
      const unknown = await mutate('post', '/api/v1/auth/password/forgot')
        .send({ email: 'never-registered@spiceroute.test' })
        .expect(200);

      expect(known.body.data.message).toBe(unknown.body.data.message);
    });
  });

  describe('password reset', () => {
    it('a reset token is single-use and revokes all existing sessions', async () => {
      const owner = await registerAndVerify();

      // Two independent sessions (e.g. two browsers/devices).
      const session1 = cookieHeader(await login(owner.email, owner.password).expect(200));
      const session2 = cookieHeader(await login(owner.email, owner.password).expect(200));
      await get('/api/v1/auth/me', session1).expect(200);
      await get('/api/v1/auth/me', session2).expect(200);

      await mutate('post', '/api/v1/auth/password/forgot').send({ email: owner.email }).expect(200);
      const token = ctx.notifier.passwordResetTokens.get(owner.email);
      if (!token) throw new Error('reset token was not captured');

      await mutate('post', '/api/v1/auth/password/reset')
        .send({ token, newPassword: 'a-brand-new-strong-password' })
        .expect(200);

      // Both prior sessions are dead.
      await get('/api/v1/auth/me', session1).expect(401);
      await get('/api/v1/auth/me', session2).expect(401);

      // The token cannot be reused.
      await mutate('post', '/api/v1/auth/password/reset')
        .send({ token, newPassword: 'yet-another-strong-password' })
        .expect(422);

      // The new password works; the old one no longer does.
      await login(owner.email, 'a-brand-new-strong-password').expect(200);
      await login(owner.email, owner.password).expect(401);
    });

    it('rejects a reset with a password that fails policy', async () => {
      const owner = await registerAndVerify();
      await mutate('post', '/api/v1/auth/password/forgot').send({ email: owner.email }).expect(200);
      const token = ctx.notifier.passwordResetTokens.get(owner.email)!;

      await mutate('post', '/api/v1/auth/password/reset')
        .send({ token, newPassword: 'short' })
        .expect(422);
    });
  });

  describe('refresh-token rotation and reuse detection', () => {
    it('presenting an already-rotated refresh token revokes the entire session family (HTTP level)', async () => {
      const owner = await registerAndVerify();
      const originalCookie = cookieHeader(await login(owner.email, owner.password).expect(200));

      const rotatedRes = await mutate('post', '/api/v1/auth/refresh', originalCookie).expect(200);
      const rotatedCookie = cookieHeader(rotatedRes);

      // Reusing the original (already-exchanged) refresh token...
      await mutate('post', '/api/v1/auth/refresh', originalCookie).expect(401);

      // ...kills the whole family, including the token from the legitimate rotation.
      await mutate('post', '/api/v1/auth/refresh', rotatedCookie).expect(401);
      await get('/api/v1/auth/me', rotatedCookie).expect(401);
    });
  });

  describe('rate limiting (docs/04-api-specification.md §8.2)', () => {
    it('the 11th login attempt within the window from one IP returns 429 with Retry-After', async () => {
      let last: SupertestResponse | undefined;
      for (let i = 0; i < 11; i++) {
        last = await login('irrelevant@spiceroute.test', 'irrelevant-password');
      }
      expect(last!.status).toBe(429);
      expect(last!.headers['retry-after']).toBeTruthy();
    });

    it('registration is rate limited per IP', async () => {
      let last: SupertestResponse | undefined;
      for (let i = 0; i < 6; i++) {
        last = await mutate('post', '/api/v1/auth/register').send({
          ...OWNER,
          email: `owner-${i}@spiceroute.test`,
        });
      }
      expect(last!.status).toBe(429);
    });
  });

  describe('GET /auth/me field allowlist (Phase 3 acceptance criteria)', () => {
    it('never returns a password hash, token, or secret field', async () => {
      const owner = await registerAndVerify();
      const sessionCookie = cookieHeader(await login(owner.email, owner.password).expect(200));

      const res = await get('/api/v1/auth/me', sessionCookie).expect(200);

      const ALLOWED_FIELDS = new Set([
        'id',
        'email',
        'phone',
        'fullName',
        'status',
        'emailVerified',
        'phoneVerified',
        'createdAt',
        'restaurantMemberships',
      ]);
      const actualFields = Object.keys(res.body.data);

      expect(actualFields.every((field) => ALLOWED_FIELDS.has(field))).toBe(true);
      expect(res.body.data).not.toHaveProperty('passwordHash');
      expect(res.body.data).not.toHaveProperty('password_hash');
      expect(res.body.data).not.toHaveProperty('mfaSecret');
      expect(JSON.stringify(res.body)).not.toContain(owner.password);
    });

    it('returns 401 with no Cookie at all', async () => {
      await get('/api/v1/auth/me').expect(401);
    });
  });

  describe('disabled user (Phase 3 acceptance criteria)', () => {
    it('cannot log in even with the correct password', async () => {
      const owner = await registerAndVerify();
      const user = ctx.db.users.find((u) => u.email === owner.email)!;
      user.status = 'DISABLED';

      await login(owner.email, owner.password).expect(401);
    });

    it('an existing valid access token stops working the moment the user is disabled', async () => {
      const owner = await registerAndVerify();
      const sessionCookie = cookieHeader(await login(owner.email, owner.password).expect(200));
      await get('/api/v1/auth/me', sessionCookie).expect(200);

      const user = ctx.db.users.find((u) => u.email === owner.email)!;
      user.status = 'DISABLED';

      await get('/api/v1/auth/me', sessionCookie).expect(401);
    });
  });

  describe('input validation (docs/09-security.md §15.4)', () => {
    it('rejects a weak password on registration with 422', async () => {
      await mutate('post', '/api/v1/auth/register')
        .send({ ...OWNER, email: 'weak@spiceroute.test', password: 'short' })
        .expect(422);
    });

    it('strips unknown / privileged fields from the request body instead of merging them', async () => {
      await mutate('post', '/api/v1/auth/register')
        .send({ ...OWNER, email: 'stripped@spiceroute.test', role: 'ADMIN', isAdmin: true })
        .expect(200);

      const created = ctx.db.users.find((u) => u.email === 'stripped@spiceroute.test');
      expect(created).toBeDefined();
      expect(created).not.toHaveProperty('role');
      expect(created).not.toHaveProperty('isAdmin');
    });

    it('rejects a malformed email with the standard error envelope', async () => {
      const res = await mutate('post', '/api/v1/auth/login')
        .send({ email: 'not-an-email', password: 'whatever12345' })
        .expect(422);

      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.requestId).toEqual(expect.any(String));
    });

    it('rejects a mutating request with no CSRF token at all (docs/09-security.md §15.7)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: OWNER.email, password: OWNER.password })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects a mutating request whose CSRF header does not match its CSRF cookie', async () => {
      await request(ctx.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Cookie', ctx.csrfCookie)
        .set('X-CSRF-Token', 'a-token-that-does-not-match-the-cookie')
        .send({ email: OWNER.email, password: OWNER.password })
        .expect(403);
    });
  });

  describe('email verification', () => {
    it('an unverified account can still log in — email verification does not gate login in Phase 3', async () => {
      await mutate('post', '/api/v1/auth/register').send(OWNER).expect(200);
      await login(OWNER.email, OWNER.password).expect(200);
    });

    it('a wrong verification code does not consume the challenge — the right one still works after', async () => {
      await mutate('post', '/api/v1/auth/register').send(OWNER).expect(200);
      const code = ctx.notifier.emailVerificationCodes.get(OWNER.email)!;

      await mutate('post', '/api/v1/auth/otp/verify')
        .send({ identifier: OWNER.email, purpose: 'EMAIL_VERIFICATION', code: '000000' })
        .expect(422);

      await mutate('post', '/api/v1/auth/otp/verify')
        .send({ identifier: OWNER.email, purpose: 'EMAIL_VERIFICATION', code })
        .expect(200);

      const user = ctx.db.users.find((u) => u.email === OWNER.email)!;
      expect(user.emailVerifiedAt).not.toBeNull();
    });
  });
});
