import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Session, User } from '@prisma/client';
import { ACCESS_TOKEN_COOKIE } from '../auth.constants.js';
import { UserRepository } from '../repositories/user.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';
import { TokenService } from './token.service.js';

export interface OptionalIdentity {
  user: User;
  session: Session;
}

/**
 * `AuthGuard` minus the throw — Phase 16's guest-checkout-must-never-
 * block requirement (AMB-2) meets Phase 3's "never trust the JWT alone"
 * rule at exactly one endpoint, `POST /public/checkout`: it must keep
 * working with NO access-token cookie at all (guest checkout, the
 * common case), but when a cookie IS present and points at a live
 * session, `CheckoutService` needs the resolved User to reuse that
 * customer's permanent Customer row instead of creating a fresh guest
 * one, and to honour `redeemLoyaltyPoints`. Every check below is
 * identical to `AuthGuard.canActivate` (live user status, live session
 * revocation/expiry — never the JWT payload alone) — only the outcome
 * on failure differs: `null`, not `UnauthenticatedError`.
 */
@Injectable()
export class OptionalAuthService {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
  ) {}

  async resolve(request: FastifyRequest): Promise<OptionalIdentity | null> {
    const token = request.cookies?.[ACCESS_TOKEN_COOKIE];
    if (!token) return null;

    const payload = this.tokens.verifyAccessToken(token);
    if (!payload) return null;

    const [user, session] = await Promise.all([
      this.users.findById(payload.sub),
      this.sessions.findById(payload.sid),
    ]);

    if (!user || user.status === 'DISABLED') return null;
    if (!session || session.userId !== user.id || session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() < Date.now()) return null;

    return { user, session };
  }
}
