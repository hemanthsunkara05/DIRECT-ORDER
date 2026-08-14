import { Inject, Injectable } from '@nestjs/common';
import type { LoyaltyRedemption, Prisma } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

/**
 * The row itself is created as a nested write under `Order.create`
 * (`CheckoutService.createOrderAttempt`, mirroring how
 * `PromotionRedemption` rows are created), never through a standalone
 * method here — `orderId` and `customerId` are then both known/
 * auto-linked by construction. This repository owns the READ/UPDATE
 * side: the availability check's aggregate, and the confirm/release
 * transitions `LoyaltyOutboxConsumer` drives.
 */
@Injectable()
export class LoyaltyRedemptionRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Sum of points across this customer's currently-RESERVED (not yet confirmed or released) redemptions — the "already spoken for" amount `LoyaltyRedemptionService.checkAndLock` subtracts from the locked balance. */
  async sumReservedByCustomerId(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<number> {
    const result = await tx.loyaltyRedemption.aggregate({
      where: { customerId, status: 'RESERVED' },
      _sum: { points: true },
    });
    return result._sum.points ?? 0;
  }

  async findByOrderId(orderId: string): Promise<LoyaltyRedemption | null> {
    return this.prisma.loyaltyRedemption.findUnique({ where: { orderId } });
  }

  /** Confirm: RESERVED -> CONFIRMED. A no-op (0 rows) for the common case of an order with no redemption at all. */
  async confirmByOrderId(orderId: string): Promise<LoyaltyRedemption | null> {
    const result = await this.prisma.loyaltyRedemption.updateMany({
      where: { orderId, status: 'RESERVED' },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });
    return result.count > 0 ? this.findByOrderId(orderId) : null;
  }

  /** Release: RESERVED -> RELEASED. Structurally never touches a CONFIRMED row — same BR-90-style guarantee PromotionOutboxConsumer's `release` has. */
  async releaseByOrderId(orderId: string): Promise<void> {
    await this.prisma.loyaltyRedemption.updateMany({
      where: { orderId, status: 'RESERVED' },
      data: { status: 'RELEASED' },
    });
  }
}
