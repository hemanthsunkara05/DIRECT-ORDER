import { Inject, Injectable } from '@nestjs/common';
import type { LoyaltyLedger, LoyaltyLedgerType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateLedgerEntryInput {
  customerId: string;
  type: LoyaltyLedgerType;
  points: number;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  actorType?: string;
  actorId?: string;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Append-only (BR-97) — `create` is the only write method; there is no
 * `update`/`delete`, matching `AuditService`'s own enforcement shape
 * (the same "no method exists to break the rule" pattern), backed a
 * second time by `prisma/grants.sql` revoking UPDATE/DELETE on
 * `loyalty_ledger` from the runtime role.
 */
@Injectable()
export class LoyaltyLedgerRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * `tx` is required, not optional — every ledger write in this codebase
   * happens inside the same transaction as the LoyaltyAccount balance
   * update it justifies (see repository-level doc comment on
   * LoyaltyAccountRepository). A P2002 here (duplicate
   * `(type, referenceType, referenceId)`) is the actual idempotency
   * mechanism for automatic award types — callers catch it via
   * `isUniqueConstraintViolation`, exactly like every other
   * insert-and-let-the-constraint-decide path in this codebase.
   */
  async create(
    tx: Prisma.TransactionClient,
    input: CreateLedgerEntryInput,
  ): Promise<LoyaltyLedger> {
    return tx.loyaltyLedger.create({
      data: {
        customerId: input.customerId,
        type: input.type,
        points: input.points,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        description: input.description,
        actorType: input.actorType ?? 'SYSTEM',
        actorId: input.actorId,
      },
    });
  }

  async listByCustomerId(
    customerId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<LoyaltyLedger>> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const items = await this.prisma.loyaltyLedger.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > limit;
    return { items: hasMore ? items.slice(0, limit) : items, hasMore };
  }

  /** Reconciliation only — the authoritative sum BR-97 measures the cached balance against. */
  async sumByCustomerId(customerId: string): Promise<number> {
    const result = await this.prisma.loyaltyLedger.aggregate({
      where: { customerId },
      _sum: { points: true },
    });
    return result._sum.points ?? 0;
  }

  /**
   * Phase 19: the batched form of `sumByCustomerId`, one query for
   * every customer with at least one ledger entry rather than one
   * query per account — `LoyaltyReconciliationService.reconcile()`
   * used to call `sumByCustomerId` in a loop (a real 1+N pattern,
   * found during Phase 19's query-optimization review), which this
   * replaces. A customer with an account but zero ledger entries
   * (freshly created, balance 0) simply has no key in the returned
   * map — callers treat a missing key as sum 0, the same default
   * `sumByCustomerId` already returns via `?? 0`.
   */
  async sumAllGroupedByCustomer(): Promise<Map<string, number>> {
    const rows = await this.prisma.loyaltyLedger.groupBy({
      by: ['customerId'],
      _sum: { points: true },
    });
    return new Map(rows.map((r) => [r.customerId, r._sum.points ?? 0]));
  }
}
