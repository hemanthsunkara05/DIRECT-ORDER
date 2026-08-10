import { Inject, Injectable } from '@nestjs/common';
import type { OtpChallenge, OtpPurpose } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateOtpChallengeInput {
  identifier: string;
  purpose: OtpPurpose;
  codeHash: string;
  expiresAt: Date;
  maxAttempts?: number;
}

@Injectable()
export class OtpChallengeRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateOtpChallengeInput): Promise<OtpChallenge> {
    return this.prisma.otpChallenge.create({ data: input });
  }

  /**
   * The most recent not-yet-consumed challenge for this identifier +
   * purpose — deliberately NOT filtered by expiry here. OtpService.verify()
   * needs to tell "no such challenge" (INVALID) apart from "found it, but
   * it's expired" (EXPIRED); filtering expired rows out of this query
   * would make that distinction impossible to observe (an expired row
   * would look identical to a nonexistent one), silently downgrading
   * every expired-code attempt to a generic INVALID.
   */
  async findLatestUnconsumed(
    identifier: string,
    purpose: OtpPurpose,
  ): Promise<OtpChallenge | null> {
    return this.prisma.otpChallenge.findFirst({
      where: { identifier, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Looks up a challenge by its secret's hash alone, with no identifier
   * to narrow the search — used for PASSWORD_RESET, where the link the
   * user clicks carries only the token, not their email. Not filtered by
   * expiry for the same reason as findLatestUnconsumed above.
   */
  async findLatestUnconsumedByHash(
    purpose: OtpPurpose,
    codeHash: string,
  ): Promise<OtpChallenge | null> {
    return this.prisma.otpChallenge.findFirst({
      where: { purpose, codeHash, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async incrementAttempts(id: string): Promise<void> {
    await this.prisma.otpChallenge.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
  }

  async consume(id: string): Promise<void> {
    await this.prisma.otpChallenge.update({ where: { id }, data: { consumedAt: new Date() } });
  }
}
