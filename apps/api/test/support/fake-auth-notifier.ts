import { AuthNotifierService } from '../../src/modules/identity/services/auth-notifier.service.js';

/**
 * Captures the last secret sent per identifier instead of logging it, so
 * tests can complete a register→verify or forgot→reset flow without a
 * real email/SMS provider or scraping log output.
 */
export class FakeAuthNotifierService extends AuthNotifierService {
  readonly emailVerificationCodes = new Map<string, string>();
  readonly phoneVerificationCodes = new Map<string, string>();
  readonly passwordResetTokens = new Map<string, string>();

  constructor() {
    super(undefined as never);
  }

  override notifyEmailVerificationCode(identifier: string, code: string): void {
    this.emailVerificationCodes.set(identifier, code);
  }

  override notifyPhoneVerificationCode(identifier: string, code: string): void {
    this.phoneVerificationCodes.set(identifier, code);
  }

  override notifyPasswordResetToken(identifier: string, token: string): void {
    this.passwordResetTokens.set(identifier, token);
  }
}
