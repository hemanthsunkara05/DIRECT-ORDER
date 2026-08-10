import { Inject, Injectable } from '@nestjs/common';
import type { Session } from '@prisma/client';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { SessionRepository } from '../repositories/session.repository.js';
import { TokenService } from './token.service.js';

export interface SessionContext {
  userAgent?: string;
  ipHash?: string;
}

export interface IssuedSession {
  session: Session;
  refreshToken: string;
}

export type RotateResult =
  | { outcome: 'ROTATED'; userId: string; issued: IssuedSession }
  | { outcome: 'INVALID' }
  | { outcome: 'EXPIRED' }
  | { outcome: 'REUSE_DETECTED'; userId: string };

const DAY_MS = 86_400_000;

/**
 * Owns the refresh-token rotation and reuse-detection state machine
 * (docs/09-security.md §15.2). This is the one place `Session` rows are
 * created or revoked — AuthService calls this rather than touching
 * SessionRepository directly, so the reuse-detection logic can never be
 * bypassed by a shortcut elsewhere.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  async createSession(userId: string, context: SessionContext = {}): Promise<IssuedSession> {
    const refreshToken = this.tokens.generateRefreshToken();
    // familyId omitted: SessionRepository.create() defaults it to the
    // new row's own id, correctly starting a fresh family for this login.
    const session = await this.sessions.create({
      userId,
      refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
      expiresAt: this.refreshExpiry(),
      userAgent: context.userAgent,
      ipHash: context.ipHash,
    });
    return { session, refreshToken };
  }

  /**
   * The refresh-token rotation state machine. Every branch is a real,
   * tested acceptance criterion (Phase 3):
   *   - unknown token                → INVALID
   *   - matches a REVOKED session    → REUSE_DETECTED, whole family killed
   *   - matches an expired session   → EXPIRED
   *   - matches a live session       → ROTATED, new session issued
   */
  async rotate(refreshToken: string, context: SessionContext = {}): Promise<RotateResult> {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const existing = await this.sessions.findByHash(hash);

    if (!existing) {
      return { outcome: 'INVALID' };
    }

    if (existing.revokedAt) {
      await this.sessions.revokeFamily(existing.familyId, 'REFRESH_TOKEN_REUSE_DETECTED');
      await this.audit.record({
        actorType: 'SYSTEM',
        actorId: existing.userId,
        action: 'SESSION_REUSE_DETECTED',
        entityType: 'Session',
        entityId: existing.id,
        reason:
          'A refresh token that was already rotated (or previously revoked) was presented again. The entire session family was revoked as a token-theft precaution.',
      });
      return { outcome: 'REUSE_DETECTED', userId: existing.userId };
    }

    if (existing.expiresAt.getTime() < Date.now()) {
      return { outcome: 'EXPIRED' };
    }

    const newRefreshToken = this.tokens.generateRefreshToken();
    const rotated = await this.sessions.rotate(existing.id, {
      userId: existing.userId,
      familyId: existing.familyId,
      refreshTokenHash: this.tokens.hashRefreshToken(newRefreshToken),
      expiresAt: this.refreshExpiry(),
      userAgent: context.userAgent,
      ipHash: context.ipHash,
      rotatedFromId: existing.id,
    });

    return {
      outcome: 'ROTATED',
      userId: existing.userId,
      issued: { session: rotated, refreshToken: newRefreshToken },
    };
  }

  async revokeSession(refreshToken: string): Promise<void> {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const existing = await this.sessions.findByHash(hash);
    if (existing) {
      await this.sessions.revoke(existing.id, 'LOGOUT');
    }
    // Idempotent: an unknown/already-revoked token is not an error — the
    // caller's intent (be logged out) is already satisfied either way.
  }

  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.sessions.revokeAllForUser(userId, reason);
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * DAY_MS);
  }
}
