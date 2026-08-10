import { randomBytes, createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';

export interface AccessTokenPayload {
  sub: string; // userId
  sid: string; // sessionId
}

/**
 * Access tokens carry identity and a session reference only — `sub`
 * (userId) and `sid` (session id) — never roles or restaurant
 * memberships. `sid` is not itself trusted as proof of anything; it is
 * only a lookup key AuthGuard uses to re-check that specific session's
 * live/revoked status on every request, the same way `sub` is only a
 * lookup key for the user's live status. This is what makes "Session
 * revocation ... revoke immediately" (docs/09-security.md §15.2) true
 * even though the token itself remains cryptographically valid for up
 * to 15 minutes: logout, password reset, and reuse detection all revoke
 * the Session row, and the very next request carrying that token is
 * rejected — "Authority is re-derived per request" applies to session
 * liveness here, and to roles/restaurant membership from Phase 4 onward.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(JwtService) private readonly jwt: JwtService,
  ) {}

  signAccessToken(userId: string, sessionId: string): string {
    const payload: AccessTokenPayload = { sub: userId, sid: sessionId };
    return this.jwt.sign(payload, {
      secret: this.env.JWT_SECRET,
      expiresIn: this.env.JWT_ACCESS_TTL_SECONDS,
    });
  }

  /** Returns null for any invalid, expired, or tampered token rather than throwing. */
  verifyAccessToken(token: string): AccessTokenPayload | null {
    try {
      return this.jwt.verify<AccessTokenPayload>(token, { secret: this.env.JWT_SECRET });
    } catch {
      return null;
    }
  }

  /**
   * Opaque random 256-bit refresh token (docs/09-security.md §15.2) —
   * not a JWT. The raw value is returned to the caller once (to become
   * a cookie); only its hash is ever persisted (Session.refreshTokenHash).
   */
  generateRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * SHA-256, not argon2: this hashes a high-entropy 256-bit random value,
   * not a human-chosen password. Argon2's deliberate slowness defends
   * against guessing a low-entropy secret — irrelevant here, and would
   * needlessly cost real latency on every authenticated request.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
