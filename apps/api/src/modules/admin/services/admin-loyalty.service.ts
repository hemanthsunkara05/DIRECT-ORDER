import { Inject, Injectable } from '@nestjs/common';
import type { LoyaltyAccount, LoyaltyLedger } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { LoyaltyAccountRepository } from '../../loyalty/repositories/loyalty-account.repository.js';
import { LoyaltyLedgerRepository, type Page } from '../../loyalty/repositories/loyalty-ledger.repository.js';

export interface AdminLoyaltyView {
  account: LoyaltyAccount | null;
  ledger: Page<LoyaltyLedger>;
}

/**
 * `GET /admin/loyalty/:customerId` (`loyalty:read`, SUPPORT+) and
 * `POST /admin/loyalty/:customerId/adjust` (`loyalty:adjust`,
 * SUPER_ADMIN only) — docs/04-api-specification.md §8.8. BR-106:
 * "admin adjustments write a ledger entry with actor and reason.
 * Direct balance mutation does not exist" — `adjust` below is the ONE
 * place an admin can change a balance, and it does so exactly the same
 * way every other balance change in this codebase does: a ledger
 * insert plus the derived-cache update, in the same transaction, never
 * a bare `UPDATE loyalty_accounts SET balance_points = ...`.
 * `ADMIN_ADJUSTMENT` is excluded from the ledger's automatic-award
 * uniqueness constraint (see the migration's own comment) precisely so
 * an admin can adjust the same customer more than once for unrelated
 * reasons — there is no `referenceId` to dedupe against here.
 */
@Injectable()
export class AdminLoyaltyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LoyaltyAccountRepository) private readonly accounts: LoyaltyAccountRepository,
    @Inject(LoyaltyLedgerRepository) private readonly ledger: LoyaltyLedgerRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async view(customerId: string, options: { cursor?: string; limit?: number } = {}): Promise<AdminLoyaltyView> {
    const account = await this.accounts.findByCustomerId(customerId);
    const ledgerPage = await this.ledger.listByCustomerId(customerId, options);
    return { account, ledger: ledgerPage };
  }

  async adjust(
    customerId: string,
    points: number,
    reason: string,
    adminUserId: string,
  ): Promise<LoyaltyAccount> {
    if (points === 0) {
      throw new ValidationError('points must be a non-zero integer.');
    }
    const account = await this.accounts.findByCustomerId(customerId);
    if (!account) {
      throw new NotFoundError('This customer has no loyalty account.');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.ledger.create(tx, {
        customerId,
        type: 'ADMIN_ADJUSTMENT',
        points,
        description: reason,
        actorType: 'ADMIN',
        actorId: adminUserId,
      });
      await this.accounts.applyDelta(tx, customerId, { balancePoints: points });
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: 'LOYALTY_BALANCE_ADJUSTED',
      entityType: 'LoyaltyAccount',
      entityId: account.id,
      before: { balancePoints: account.balancePoints },
      after: { balancePoints: account.balancePoints + points },
      reason,
    });

    return (await this.accounts.findByCustomerId(customerId))!;
  }
}
