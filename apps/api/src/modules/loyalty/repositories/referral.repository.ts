import { Inject, Injectable } from '@nestjs/common';
import type { Referral, ReferralCode, ReferralStatus } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Covers both `ReferralCode` (one per customer, generated on first access) and `Referral` (one row per successful attribution) — small enough tables that splitting into two repository classes would be pure ceremony. */
@Injectable()
export class ReferralRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findCodeByCustomerId(customerId: string): Promise<ReferralCode | null> {
    return this.prisma.referralCode.findUnique({ where: { customerId } });
  }

  /** Insert-and-let-the-constraint-decide (`customerId` and `code` are both `@unique`) — the caller retries the lookup on a P2002 rather than this method resolving the race itself. */
  async createCode(customerId: string, code: string): Promise<ReferralCode> {
    return this.prisma.referralCode.create({ data: { customerId, code } });
  }

  async findActiveCode(code: string): Promise<ReferralCode | null> {
    const row = await this.prisma.referralCode.findUnique({ where: { code } });
    return row && row.isActive ? row : null;
  }

  async findByReferredCustomerId(referredCustomerId: string): Promise<Referral | null> {
    return this.prisma.referral.findUnique({ where: { referredCustomerId } });
  }

  async findByQualifyingOrderId(qualifyingOrderId: string): Promise<Referral | null> {
    return this.prisma.referral.findUnique({ where: { qualifyingOrderId } });
  }

  /**
   * BR-110: attribution at signup. `referralCode` is stored verbatim as
   * a denormalised snapshot (the Referral model's own doc comment) —
   * the unique constraint on `referredCustomerId` (BR-108: "at most one
   * referrer, ever") is what a concurrent double-attribution attempt
   * collides against; callers catch the P2002 the same way every other
   * insert-and-let-the-constraint-decide path in this codebase does.
   */
  async create(input: {
    referrerCustomerId: string;
    referredCustomerId: string;
    referralCode: string;
  }): Promise<Referral> {
    return this.prisma.referral.create({ data: input });
  }

  async listByReferrer(
    referrerCustomerId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Referral>> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const items = await this.prisma.referral.findMany({
      where: { referrerCustomerId },
      orderBy: { attributedAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > limit;
    return { items: hasMore ? items.slice(0, limit) : items, hasMore };
  }

  async updateStatus(
    id: string,
    status: ReferralStatus,
    extra: { qualifyingOrderId?: string; qualifiedAt?: Date; rewardedAt?: Date } = {},
  ): Promise<Referral> {
    return this.prisma.referral.update({
      where: { id },
      data: { status, ...extra },
    });
  }
}
