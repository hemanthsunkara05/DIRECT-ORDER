import { Controller, Get, HttpCode, Inject, Query, UseGuards } from '@nestjs/common';
import type { Customer } from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CustomerAccountGuard } from '../guards/customer-account.guard.js';
import { CurrentCustomer } from '../decorators/current-customer.decorator.js';
import { LoyaltyAccountRepository } from '../repositories/loyalty-account.repository.js';
import { LoyaltyLedgerRepository } from '../repositories/loyalty-ledger.repository.js';
import { ReferralService } from '../services/referral.service.js';
import { ReferralRepository } from '../repositories/referral.repository.js';

/**
 * `/me/loyalty*`, `/me/referrals` (docs/04-api-specification.md §8.4).
 * `GET /me/notifications`'s own doc comment (Phase 12) says "there is
 * deliberately no CUSTOMER branch ... no registered customer session
 * exists to authenticate /me/* against" — Phase 16 is what changes that
 * premise; this controller is the first to actually authenticate a
 * `/me/*` route as a customer rather than restaurant staff.
 */
@Controller('me')
@UseGuards(AuthGuard, CustomerAccountGuard)
export class MeLoyaltyController {
  constructor(
    @Inject(LoyaltyAccountRepository) private readonly accounts: LoyaltyAccountRepository,
    @Inject(LoyaltyLedgerRepository) private readonly ledger: LoyaltyLedgerRepository,
    @Inject(ReferralRepository) private readonly referrals: ReferralRepository,
    @Inject(ReferralService) private readonly referralService: ReferralService,
  ) {}

  @Get('loyalty')
  @HttpCode(200)
  async getBalance(@CurrentCustomer() customer: Customer) {
    const account = await this.accounts.findByCustomerId(customer.id);
    return ok({
      balancePoints: account?.balancePoints ?? 0,
      lifetimeEarned: account?.lifetimeEarned ?? 0,
      lifetimeRedeemed: account?.lifetimeRedeemed ?? 0,
      status: account?.status ?? 'ACTIVE',
    });
  }

  @Get('loyalty/ledger')
  @HttpCode(200)
  async getLedger(
    @CurrentCustomer() customer: Customer,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parseLimit(limitRaw);
    const page = await this.ledger.listByCustomerId(customer.id, { cursor, limit });
    return okPage(
      page.items.map((entry) => ({
        id: entry.id,
        type: entry.type,
        points: entry.points,
        description: entry.description,
        createdAt: entry.createdAt,
      })),
      {
        nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
        hasMore: page.hasMore,
        limit: limit ?? 20,
      },
    );
  }

  /**
   * BR-115: "referrers see referral status but no personal data about
   * the referred customer" — the response below is an explicit
   * allowlist (status + timestamps only), the same posture Phase 15's
   * `toPublicReview` established for exposing one party's data to
   * another.
   */
  @Get('referrals')
  @HttpCode(200)
  async getReferrals(
    @CurrentCustomer() customer: Customer,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const code = await this.referralService.getOrCreateCode(customer.id);
    const limit = parseLimit(limitRaw);
    const page = await this.referrals.listByReferrer(customer.id, { cursor, limit });
    return ok({
      code: code.code,
      isActive: code.isActive,
      referrals: page.items.map((r) => ({
        status: r.status,
        attributedAt: r.attributedAt,
        qualifiedAt: r.qualifiedAt,
        rewardedAt: r.rewardedAt,
      })),
      hasMore: page.hasMore,
    });
  }
}

function parseLimit(limitRaw?: string): number | undefined {
  if (limitRaw === undefined) return undefined;
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new ValidationError('limit must be a positive integer.');
  }
  return limit;
}
