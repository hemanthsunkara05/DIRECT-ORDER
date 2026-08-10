import { Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { UserRepository } from '../repositories/user.repository.js';
import { PasswordService } from './password.service.js';
import { SessionService, type SessionContext, type IssuedSession } from './session.service.js';
import { TokenService } from './token.service.js';
import { OtpService } from './otp.service.js';
import { AuthNotifierService } from './auth-notifier.service.js';
import { LoginThrottleService } from './login-throttle.service.js';

/**
 * Hashed against on every login where the account doesn't exist, so the
 * argon2 cost — the dominant cost of the whole call — is paid identically
 * whether or not the email matches a real user (docs/09-security.md
 * §15.2, enumeration resistance). Not a real credential; never accepted
 * for anything, never persisted.
 */
const DUMMY_PASSWORD_FOR_TIMING = 'not-a-real-password-used-only-to-equalise-login-timing';

export interface RegisterInput {
  email: string;
  fullName: string;
  password: string;
}

export type LoginResult =
  | { outcome: 'SUCCESS'; user: User; issued: IssuedSession; accessToken: string }
  | { outcome: 'FAILED' }
  | { outcome: 'LOCKED' }
  | { outcome: 'DISABLED' };

export type RefreshResult =
  | { outcome: 'ROTATED'; issued: IssuedSession; accessToken: string }
  | { outcome: 'INVALID' }
  | { outcome: 'EXPIRED' }
  | { outcome: 'REUSE_DETECTED' };

export type ResetPasswordResult = 'RESET' | 'INVALID' | 'EXPIRED';

export type VerifyPurpose = 'EMAIL_VERIFICATION' | 'PHONE_VERIFICATION';
export type VerifyResult = 'VERIFIED' | 'INVALID' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS';

/**
 * Orchestrates registration, login, logout, refresh, password reset, and
 * email/phone verification. This is the ONLY place these flows are
 * assembled — AuthController stays a thin translation layer between HTTP
 * and this service, so the enumeration-resistance and session-security
 * rules below apply no matter which transport calls them (e.g. a future
 * admin CLI or the invitations flow reusing session issuance).
 */
@Injectable()
export class AuthService {
  private dummyHash: Promise<string> | undefined;

  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(AuthNotifierService) private readonly notifier: AuthNotifierService,
    @Inject(LoginThrottleService) private readonly throttle: LoginThrottleService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Always resolves the same way whether or not `email` is already
   * registered — no duplicate user is created, but the caller cannot
   * tell the difference from the response (docs/09-security.md §15.2:
   * enumeration resistance covers registration, not just login).
   */
  async register(input: RegisterInput): Promise<void> {
    this.assertPasswordPolicy(input.password);

    const passwordHash = await this.passwords.hash(input.password);
    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      return;
    }

    const user = await this.users.create({
      email: input.email,
      fullName: input.fullName,
      passwordHash,
    });

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId: user.id,
      action: 'USER_REGISTERED',
      entityType: 'User',
      entityId: user.id,
    });

    const issued = await this.otp.request(input.email, 'EMAIL_VERIFICATION');
    this.notifier.notifyEmailVerificationCode(input.email, issued.secret);
  }

  async login(email: string, password: string, context: SessionContext = {}): Promise<LoginResult> {
    const identifier = email.trim().toLowerCase();

    if (await this.throttle.isLocked(identifier)) {
      return { outcome: 'LOCKED' };
    }

    const user = await this.users.findByEmail(identifier);
    const hashToCheck = user?.passwordHash ?? (await this.getDummyHash());
    const passwordOk = await this.passwords.verify(hashToCheck, password);

    if (!user || !user.passwordHash || !passwordOk) {
      await this.throttle.recordFailure(identifier);
      return { outcome: 'FAILED' };
    }

    // Credentials were correct — this is the real account owner, so the
    // throttle counter is cleared even on the DISABLED branch below.
    await this.throttle.reset(identifier);

    if (user.status === 'DISABLED') {
      return { outcome: 'DISABLED' };
    }

    const issued = await this.sessions.createSession(user.id, context);
    await this.users.recordLogin(user.id);
    const accessToken = this.tokens.signAccessToken(user.id, issued.session.id);

    return { outcome: 'SUCCESS', user, issued, accessToken };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.sessions.revokeSession(refreshToken);
  }

  async refresh(refreshToken: string, context: SessionContext = {}): Promise<RefreshResult> {
    const result = await this.sessions.rotate(refreshToken, context);

    if (result.outcome === 'ROTATED') {
      return {
        outcome: 'ROTATED',
        issued: result.issued,
        accessToken: this.tokens.signAccessToken(result.userId, result.issued.session.id),
      };
    }

    return { outcome: result.outcome };
  }

  /** Always resolves the same way regardless of whether `email` exists (docs §15.2, API §8.2). */
  async forgotPassword(email: string): Promise<void> {
    const identifier = email.trim().toLowerCase();
    const user = await this.users.findByEmail(identifier);
    if (!user) {
      return;
    }

    const issued = await this.otp.request(identifier, 'PASSWORD_RESET');
    this.notifier.notifyPasswordResetToken(identifier, issued.secret);
  }

  async resetPassword(token: string, newPassword: string): Promise<ResetPasswordResult> {
    this.assertPasswordPolicy(newPassword);

    const verification = await this.otp.verifyResetToken(token);
    if (verification.outcome !== 'VERIFIED') {
      return verification.outcome;
    }

    const user = await this.users.findByEmail(verification.identifier);
    if (!user) {
      return 'INVALID';
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.users.updatePasswordHash(user.id, passwordHash);
    await this.sessions.revokeAllForUser(user.id, 'PASSWORD_RESET');
    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId: user.id,
      action: 'PASSWORD_RESET',
      entityType: 'User',
      entityId: user.id,
      reason: 'Password reset via emailed token; all existing sessions revoked.',
    });

    return 'RESET';
  }

  /**
   * Not enumeration-resistant by design — unlike register/login/forgot,
   * this is a "resend my own verification code" action a signed-out user
   * takes on themselves. Whether `identifier` belongs to an account is
   * not sensitive here the way it is for login/registration/reset.
   */
  async requestVerification(identifier: string, purpose: VerifyPurpose): Promise<void> {
    const issued = await this.otp.request(identifier, purpose);
    if (purpose === 'EMAIL_VERIFICATION') {
      this.notifier.notifyEmailVerificationCode(identifier, issued.secret);
    } else {
      this.notifier.notifyPhoneVerificationCode(identifier, issued.secret);
    }
  }

  async verify(identifier: string, purpose: VerifyPurpose, code: string): Promise<VerifyResult> {
    const result = await this.otp.verify(identifier, purpose, code);
    if (result !== 'VERIFIED') {
      return result;
    }

    const user =
      purpose === 'EMAIL_VERIFICATION'
        ? await this.users.findByEmail(identifier)
        : await this.users.findByPhone(identifier);

    if (user) {
      if (purpose === 'EMAIL_VERIFICATION') {
        await this.users.markEmailVerified(user.id);
      } else {
        await this.users.markPhoneVerified(user.id);
      }
    }

    return 'VERIFIED';
  }

  async getCurrentUser(userId: string): Promise<User | null> {
    return this.users.findById(userId);
  }

  private assertPasswordPolicy(password: string): void {
    const issues = this.passwords.validatePolicy(password);
    if (issues.length > 0) {
      throw new ValidationError(
        'Password does not meet the required policy.',
        issues.map((message) => ({ message })),
      );
    }
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash(DUMMY_PASSWORD_FOR_TIMING);
    return this.dummyHash;
  }
}
