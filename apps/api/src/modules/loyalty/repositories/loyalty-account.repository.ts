import { Inject, Injectable } from '@nestjs/common';
import type { LoyaltyAccount, Prisma } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

/**
 * `balancePoints`/`lifetimeEarned`/`lifetimeRedeemed` are a derived
 * cache (BR-97) — every mutation method here is called only from inside
 * the same transaction as the `LoyaltyLedger` insert that justifies it
 * (see LoyaltyEarnService/LoyaltyRedemptionService/LoyaltyClawbackService/
 * AdminLoyaltyService). No method on this class updates the balance
 * without a caller-supplied ledger entry alongside it — there is no
 * "just set the balance" method, by construction.
 */
@Injectable()
export class LoyaltyAccountRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Created once, at customer-account creation (`CustomerAuthService.verifyOtp`) — every registered Customer gets a LoyaltyAccount immediately, balance 0. */
  async create(customerId: string): Promise<LoyaltyAccount> {
    return this.prisma.loyaltyAccount.create({ data: { customerId } });
  }

  async findByCustomerId(customerId: string): Promise<LoyaltyAccount | null> {
    return this.prisma.loyaltyAccount.findUnique({ where: { customerId } });
  }

  /**
   * Real `SELECT ... FOR UPDATE` (docs/02 §6.3, the same pattern Phase
   * 14 verified against real Postgres for promotions) — must be called
   * inside an open transaction. Returns only the id/balance the caller
   * needs while holding the lock; the caller re-reads the full typed
   * row separately if it needs more, same as
   * `PromotionReservationService.checkAndLock`.
   */
  async lockByCustomerId(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<{ id: string; balancePoints: number } | null> {
    // `::uuid` is required — `customer_id` is a UUID column and Postgres
    // has no implicit `uuid = text` comparison operator, unlike Phase
    // 14's promotion-code lock query (`code` is TEXT, so no cast is
    // needed there). Found live against real Postgres (`operator does
    // not exist: uuid = text`, error 42883) — Prisma's `$queryRaw`
    // interpolates every parameter as text by default regardless of the
    // target column's real type, and the in-memory test fake's `$queryRaw`
    // stub never type-checks SQL at all, so this was invisible to the
    // full automated suite.
    const rows = await tx.$queryRaw<{ id: string; balance_points: number }[]>`
      SELECT id, balance_points FROM loyalty_accounts WHERE customer_id = ${customerId}::uuid FOR UPDATE
    `;
    return rows.length > 0 ? { id: rows[0]!.id, balancePoints: rows[0]!.balance_points } : null;
  }

  async applyDelta(
    tx: Prisma.TransactionClient,
    customerId: string,
    delta: { balancePoints: number; lifetimeEarned?: number; lifetimeRedeemed?: number },
  ): Promise<void> {
    await tx.loyaltyAccount.update({
      where: { customerId },
      data: {
        balancePoints: { increment: delta.balancePoints },
        ...(delta.lifetimeEarned ? { lifetimeEarned: { increment: delta.lifetimeEarned } } : {}),
        ...(delta.lifetimeRedeemed
          ? { lifetimeRedeemed: { increment: delta.lifetimeRedeemed } }
          : {}),
      },
    });
  }

  /** Reconciliation only (docs/02 §6.3: "compares SUM(points) against the cached balance") — never used to drive normal application logic. */
  async listAll(): Promise<LoyaltyAccount[]> {
    return this.prisma.loyaltyAccount.findMany();
  }
}
