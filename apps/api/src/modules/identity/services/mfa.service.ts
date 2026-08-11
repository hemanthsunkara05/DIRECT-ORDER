import { Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { TotpService } from './totp.service.js';
import { UserRepository } from '../repositories/user.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';

export interface MfaEnrollment {
  secret: string;
  otpauthUri: string;
}

/**
 * TOTP enrollment and per-session verification (Phase 13). Two-step
 * enrollment — `enroll()` stores a PENDING secret (`mfaEnabledAt` stays
 * null), `confirmEnrollment()` only flips it once a real code against
 * that secret has been proven — so an account is never marked
 * MFA-enabled on a secret nobody has actually demonstrated they can
 * generate codes for (e.g. a QR code that failed to scan correctly).
 * Both `confirmEnrollment()` and `verify()` mark the CURRENT session
 * verified on success — see `AuthorizationGuard`'s own doc comment for
 * why this is per-session, not per-user/token.
 */
@Injectable()
export class MfaService {
  constructor(
    @Inject(TotpService) private readonly totp: TotpService,
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
  ) {}

  async enroll(user: User): Promise<MfaEnrollment> {
    const secret = this.totp.generateSecret();
    await this.users.setPendingMfaSecret(user.id, secret);
    const label = user.email ?? user.phone ?? user.id;
    return { secret, otpauthUri: this.totp.buildOtpAuthUri(secret, label) };
  }

  async confirmEnrollment(user: User, sessionId: string, code: string): Promise<boolean> {
    if (!user.mfaSecret) return false;
    if (!this.totp.verify(user.mfaSecret, code)) return false;
    await this.users.confirmMfaEnabled(user.id);
    await this.sessions.markMfaVerified(sessionId);
    return true;
  }

  async verify(user: User, sessionId: string, code: string): Promise<boolean> {
    if (!user.mfaSecret || !user.mfaEnabledAt) return false;
    if (!this.totp.verify(user.mfaSecret, code)) return false;
    await this.sessions.markMfaVerified(sessionId);
    return true;
  }
}
