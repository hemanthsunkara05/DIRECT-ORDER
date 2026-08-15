import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
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
 * everywhere else in this codebase. Phase 19 graceful-shutdown review:
 * now stores and clears its own timer on `onModuleDestroy`, matching
 * those two — previously relied on `.unref()` alone, which keeps the
 * *process* from hanging but doesn't stop a NestJS module teardown
 * (e.g. between tests, or a future hot-module scenario) from leaving
 * a stale timer referencing a torn-down module's dependencies.
 */
@Injectable()
export class LoyaltyReconciliationService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LoyaltyAccountRepository) private readonly accounts: LoyaltyAccountRepository,
    @Inject(LoyaltyLedgerRepository) private readonly ledger: LoyaltyLedgerRepository,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.reconcile().catch(() => {
        /* best-effort background job — a failed reconciliation pass is not a request-path error. */
      });
    }, RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Returns the number of mismatches found (each already recorded as a
   * `ReconciliationIssue`) — used directly by tests, not just the
   * timer above. Phase 19: two queries total (one `listAll`, one
   * grouped ledger sum), not one ledger query per account — the
   * original 1+N shape only mattered at real scale, but this is the
   * kind of fix "query optimisation driven by measurement" (docs/13's
   * Phase 19 scope) exists for.
   */
  async reconcile(): Promise<number> {
    const [accounts, ledgerSums] = await Promise.all([
      this.accounts.listAll(),
      this.ledger.sumAllGroupedByCustomer(),
    ]);
    let mismatches = 0;

    for (const account of accounts) {
      const ledgerSum = ledgerSums.get(account.customerId) ?? 0;
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
