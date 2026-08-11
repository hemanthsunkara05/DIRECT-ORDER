import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Session, User } from '@prisma/client';
import { UnauthenticatedError } from '../../../platform/errors/app-error.js';
import { ACCESS_TOKEN_COOKIE } from '../auth.constants.js';
import { UserRepository } from '../repositories/user.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';
import { TokenService } from '../services/token.service.js';

/**
 * Augments Fastify's request with the principal AuthGuard resolved,
 * read back by @CurrentUser(). `session` (Phase 13) is the live Session
 * row this same request already fetched to authenticate — exposed so
 * `AuthorizationGuard`'s admin branch can check `session.mfaVerifiedAt`
 * without a second, redundant database read.
 */
export interface AuthenticatedRequest extends FastifyRequest {
  user?: User;
  session?: Session;
}

/**
 * Verifies the access-token cookie AND re-reads BOTH the user's live
 * status and the specific session's live/revoked status from the
 * database on every request — never trusts the JWT payload alone. This
 * is what makes two Phase 3 acceptance criteria true simultaneously:
 *
 * - "A DISABLED user cannot use an existing valid access token" — the
 *   user's `status` is re-checked, not read off the token.
 * - "Session revocation ... revoke immediately" (docs/09-security.md
 *   §15.2) — logout, password reset, and refresh-token-reuse detection
 *   all revoke the Session row `sid` points at, so a still-cryptographically-
 *   valid access token stops working on the very next request instead of
 *   silently remaining usable for the rest of its 15-minute lifetime.
 *
 * `sid` (like `sub`) is only ever used as a lookup key here — its mere
 * presence in a validly-signed token proves nothing on its own; what
 * matters is what the database says about that session right now.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.cookies?.[ACCESS_TOKEN_COOKIE];
    if (!token) {
      throw new UnauthenticatedError();
    }

    const payload = this.tokens.verifyAccessToken(token);
    if (!payload) {
      throw new UnauthenticatedError();
    }

    const [user, session] = await Promise.all([
      this.users.findById(payload.sub),
      this.sessions.findById(payload.sid),
    ]);

    if (!user || user.status === 'DISABLED') {
      throw new UnauthenticatedError();
    }
    if (!session || session.userId !== user.id || session.revokedAt !== null) {
      throw new UnauthenticatedError();
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new UnauthenticatedError();
    }

    request.user = user;
    request.session = session;
    return true;
  }
}
