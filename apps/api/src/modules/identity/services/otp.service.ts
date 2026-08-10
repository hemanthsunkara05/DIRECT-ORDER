import { randomBytes, randomInt, createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OtpPurpose } from '@prisma/client';
import { OtpChallengeRepository } from '../repositories/otp-challenge.repository.js';

export type VerifyOtpResult = 'VERIFIED' | 'INVALID' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS';

export type VerifyResetTokenResult =
  { outcome: 'VERIFIED'; identifier: string } | { outcome: 'INVALID' | 'EXPIRED' };

const SECOND_MS = 1000;

/**
 * Numeric-code purposes (EMAIL_VERIFICATION, PHONE_VERIFICATION):
 * 6 digits, 5-minute expiry, 5 attempts — docs/09-security.md §15.2.
 * PASSWORD_RESET uses a long random token instead of a guessable 6-digit
 * code (it is often carried in a URL, not typed by hand) with a longer
 * expiry window, since a reset link is more often opened after a delay.
 */
const NUMERIC_CODE_TTL_SECONDS = 5 * 60;
const NUMERIC_CODE_MAX_ATTEMPTS = 5;
const RESET_TOKEN_TTL_SECONDS = 30 * 60;
const RESET_TOKEN_MAX_ATTEMPTS = 5;

export interface RequestedOtp {
  /** The raw code/token — deliver this to the user (email/SMS/console). Never persisted raw. */
  secret: string;
  expiresAt: Date;
}

/**
 * Unified verification mechanism for the OtpChallenge model (schema.prisma,
 * docs/01-domain-model.md §5.1). `identifier` is the email or phone the
 * challenge targets, not necessarily an existing User's — registration
 * verifies an email before the account is fully active.
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(OtpChallengeRepository) private readonly challenges: OtpChallengeRepository,
  ) {}

  async request(identifier: string, purpose: OtpPurpose): Promise<RequestedOtp> {
    const secret =
      purpose === 'PASSWORD_RESET' ? this.generateResetToken() : this.generateNumericCode();
    const ttlSeconds =
      purpose === 'PASSWORD_RESET' ? RESET_TOKEN_TTL_SECONDS : NUMERIC_CODE_TTL_SECONDS;
    const maxAttempts =
      purpose === 'PASSWORD_RESET' ? RESET_TOKEN_MAX_ATTEMPTS : NUMERIC_CODE_MAX_ATTEMPTS;
    const expiresAt = new Date(Date.now() + ttlSeconds * SECOND_MS);

    await this.challenges.create({
      identifier,
      purpose,
      codeHash: this.hash(secret),
      expiresAt,
      maxAttempts,
    });

    return { secret, expiresAt };
  }

  /**
   * Verifies `secret` against the most recent active challenge for this
   * identifier + purpose. Attempts are counted (and the challenge locked
   * out at maxAttempts) even on a wrong guess, so a fixed-size search
   * space cannot be brute-forced by retrying — this is the enforcement
   * point for the "5 attempts" half of the OTP control.
   */
  async verify(identifier: string, purpose: OtpPurpose, secret: string): Promise<VerifyOtpResult> {
    const challenge = await this.challenges.findLatestUnconsumed(identifier, purpose);
    if (!challenge) {
      return 'INVALID';
    }

    if (challenge.expiresAt.getTime() < Date.now()) {
      return 'EXPIRED';
    }

    if (challenge.attempts >= challenge.maxAttempts) {
      return 'TOO_MANY_ATTEMPTS';
    }

    if (challenge.codeHash !== this.hash(secret)) {
      await this.challenges.incrementAttempts(challenge.id);
      return 'INVALID';
    }

    await this.challenges.consume(challenge.id);
    return 'VERIFIED';
  }

  /**
   * PASSWORD_RESET-only counterpart to `verify`: the reset link carries
   * only the token, not the identifier it was issued for, so the lookup
   * goes by the token's hash instead (OtpChallengeRepository.findLatestUnconsumedByHash).
   * On success, returns the identifier so the caller can act on the right
   * account without it having been passed in.
   */
  async verifyResetToken(token: string): Promise<VerifyResetTokenResult> {
    const codeHash = this.hash(token);
    const challenge = await this.challenges.findLatestUnconsumedByHash('PASSWORD_RESET', codeHash);
    if (!challenge) {
      return { outcome: 'INVALID' };
    }

    if (challenge.expiresAt.getTime() < Date.now()) {
      return { outcome: 'EXPIRED' };
    }

    await this.challenges.consume(challenge.id);
    return { outcome: 'VERIFIED', identifier: challenge.identifier };
  }

  private generateNumericCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  private generateResetToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private hash(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }
}
