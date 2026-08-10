import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/platform/config/env.schema.js';
import { TokenService } from '../src/modules/identity/services/token.service.js';

const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(32);

function createService(overrides: Partial<Env> = {}): TokenService {
  const env = {
    JWT_SECRET: SECRET_A,
    JWT_ACCESS_TTL_SECONDS: 900,
    ...overrides,
  } as Env;
  return new TokenService(env, new JwtService());
}

describe('TokenService', () => {
  it('signs an access token carrying sub (userId) and sid (sessionId) and verifies it back', () => {
    const service = createService();
    const token = service.signAccessToken('user-123', 'session-456');
    const payload = service.verifyAccessToken(token);
    // Also carries standard JWT claims (iat/exp) — asserting a subset,
    // not full equality, since those are library-added and not app data.
    expect(payload).toMatchObject({ sub: 'user-123', sid: 'session-456' });
  });

  it('rejects a token signed with a different secret', () => {
    const issuer = createService({ JWT_SECRET: SECRET_A });
    const verifier = createService({ JWT_SECRET: SECRET_B });
    const token = issuer.signAccessToken('user-123', 'session-456');
    expect(verifier.verifyAccessToken(token)).toBeNull();
  });

  it('rejects a tampered token instead of throwing', () => {
    const service = createService();
    const token = service.signAccessToken('user-123', 'session-456');
    expect(service.verifyAccessToken(`${token}tampered`)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const service = createService({ JWT_ACCESS_TTL_SECONDS: -1 });
    const token = service.signAccessToken('user-123', 'session-456');
    expect(service.verifyAccessToken(token)).toBeNull();
  });

  it('rejects garbage input instead of throwing', () => {
    const service = createService();
    expect(service.verifyAccessToken('not-a-jwt-at-all')).toBeNull();
  });

  it('generates opaque refresh tokens that are not JWTs and are unique per call', () => {
    const service = createService();
    const a = service.generateRefreshToken();
    const b = service.generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.split('.').length).not.toBe(3); // not JWT-shaped
  });

  it('hashes a refresh token deterministically, so the same token always looks up the same session', () => {
    const service = createService();
    const token = service.generateRefreshToken();
    expect(service.hashRefreshToken(token)).toBe(service.hashRefreshToken(token));
  });

  it('never persists or exposes the raw refresh token through its hash', () => {
    const service = createService();
    const token = service.generateRefreshToken();
    expect(service.hashRefreshToken(token)).not.toContain(token);
  });
});
