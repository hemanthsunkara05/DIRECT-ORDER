import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { LoyaltyAccountRepository } from '../repositories/loyalty-account.repository.js';
import { LoyaltyLedgerRepository } from '../repositories/loyalty-ledger.repository.js';

const RECONCILE_INTERVAL_MS = 60 * 60 * 1000; // hourly — a background job, not a request-path concern.

/**
 * BR-97: "the ledger is authoritative; the account balance is a
 * derived cache reconciled on a schedule." Never silently corrects a
 * mismatch (docs/01 §5.6's `ReconciliationIssue` rule, reused here
 * rather than inventing a second mismatch-recording mechanism) —
 * `balancePoints` is left exactly as it was; a human resolves the
 * issue.
 *
 * Same lightweight self-starting in-process poller shape as
 * `OrderExpiryScheduler`/`NotificationRetryScheduler` — not a real
 * scheduled job runner, same sandbox-honesty tradeoff already applied
 * everywhere else in this codebase.
 */
@Injectable()
export class LoyaltyReconciliationService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LoyaltyAccountRepository) private readonly accounts: LoyaltyAccountRepository,
    @Inject(LoyaltyLedgerRepository) private readonly ledger: LoyaltyLedgerRepository,
  ) {}

  onModuleInit(): void {
    setInterval(() => {
      this.reconcile().catch(() => {
        /* best-effort background job — a failed reconciliation pass is not a request-path error. */
      });
    }, RECONCILE_INTERVAL_MS).unref();
  }

  /** Returns the number of mismatches found (each already recorded as a `ReconciliationIssue`) — used directly by tests, not just the timer above. */
  async reconcile(): Promise<number> {
    const accounts = await this.accounts.listAll();
    let mismatches = 0;

    for (const account of accounts) {
      const ledgerSum = await this.ledger.sumByCustomerId(account.customerId);
      if (ledgerSum !== account.balancePoints) {
        mismatches++;
        await this.prisma.reconciliationIssue.create({
          data: {
            entityType: 'LoyaltyAccount',
            entityId: account.id,
            issueType: 'LOYALTY_BALANCE_MISMATCH',
            expected: String(ledgerSum),
            actual: String(account.balancePoints),
            severity: 'HIGH',
          },
        });
      }
    }

    return mismatches;
  }
}
