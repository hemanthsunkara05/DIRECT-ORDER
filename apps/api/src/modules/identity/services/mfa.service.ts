import { Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { TotpService } from './totp.service.js';
import { UserRepository } from '../repositories/user.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';

/**
 * Local-dev-only MFA bypass code (sash's request: "checking my phone
 * every time" while repeatedly testing admin login). Gated on
 * `APP_ENV === 'local'` — the same flag `auth.controller.ts` already
 * uses to distinguish local dev everywhere else (e.g. its own
 * `secure = env.APP_ENV !== 'local'` cookie flag) — so this branch is
 * dead code the instant APP_ENV is 'staging'/'production'/'test',
 * never a runtime toggle that could be misconfigured on in a real
 * environment. A real authenticator code still works too; this is
 * purely an additional accepted value, not a replacement.
 */
const LOCAL_DEV_MFA_BYPASS_CODE = '424242';

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
    @Inject(APP_CONFIG) private readonly env: Env,
  ) {}

  private codeIsValid(secret: string, code: string): boolean {
    if (this.env.APP_ENV === 'local' && code === LOCAL_DEV_MFA_BYPASS_CODE) return true;
    return this.totp.verify(secret, code);
  }

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
    if (!this.codeIsValid(user.mfaSecret, code)) return false;
    await this.sessions.markMfaVerified(sessionId);
    return true;
  }
}
