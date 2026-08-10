import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';

/**
 * Phase-3-only stand-in for the real notification pipeline (Phase 12).
 * Logs the secret instead of emailing/texting it, so the auth flow is
 * fully exercisable end-to-end in dev/test without a real email/SMS
 * provider. `secret` deliberately appears only in this log line — no
 * other code path logs a raw OTP code or reset token.
 */
@Injectable()
export class AuthNotifierService {
  constructor(@Inject(PINO_LOGGER) private readonly logger: Logger) {}

  notifyEmailVerificationCode(identifier: string, code: string): void {
    this.logger.info(
      { identifier, code },
      '[auth-notifier] Email verification code (Phase 3 placeholder)',
    );
  }

  notifyPhoneVerificationCode(identifier: string, code: string): void {
    this.logger.info(
      { identifier, code },
      '[auth-notifier] Phone verification code (Phase 3 placeholder)',
    );
  }

  notifyPasswordResetToken(identifier: string, token: string): void {
    this.logger.info(
      { identifier, token },
      '[auth-notifier] Password reset token (Phase 3 placeholder)',
    );
  }
}
