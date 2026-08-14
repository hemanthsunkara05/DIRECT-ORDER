import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Order, ReferralCode } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { isUniqueConstraintViolation } from '../../../platform/database/prisma-errors.js';
import { ReferralRepository } from '../repositories/referral.repository.js';
import { LoyaltyAccountRepository } from '../repositories/loyalty-account.repository.js';
import { LoyaltyLedgerRepository } from '../repositories/loyalty-ledger.repository.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids misreads when shared aloud.
const CODE_LENGTH = 8;
const CODE_GENERATION_MAX_ATTEMPTS = 5;

/** No spec source names a reward size (docs/01 §5.10/§5.9 describe the mechanism, not the amount) — a documented code-level default, same treatment as `LOYALTY_REDEMPTION_MINOR_PER_POINT`. */
export const REFERRAL_REWARD_POINTS = 50;

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * BR-108..BR-116. Referral rewards are issued through the SAME
 * `LoyaltyLedger`/`LoyaltyAccount` this module already owns — "one
 * loyalty ledger, no second point store" (the architecture's own
 * founding constraint) applies to referrals exactly as it does to
 * order-earned points.
 */
@Injectable()
export class ReferralService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ReferralRepository) private readonly referrals: ReferralRepository,
    @Inject(LoyaltyAccountRepository) private readonly accounts: LoyaltyAccountRepository,
    @Inject(LoyaltyLedgerRepository) private readonly ledger: LoyaltyLedgerRepository,
  ) {}

  /** Lazily generated on first need (`/me/referrals`, or right after signup if a customer wants to refer someone) — never pre-generated for every account up front. */
  async getOrCreateCode(customerId: string): Promise<ReferralCode> {
    const existing = await this.referrals.findCodeByCustomerId(customerId);
    if (existing) return existing;

    for (let attempt = 0; attempt < CODE_GENERATION_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.referrals.createCode(customerId, generateCode());
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          const raced = await this.referrals.findCodeByCustomerId(customerId);
          if (raced) return raced;
          continue; // code collision (astronomically unlikely) — retry with a fresh one.
        }
        throw error;
      }
    }
    throw new Error('Could not generate a unique referral code.');
  }

  /**
   * BR-110: "attribution occurs at signup; the referral code is
   * resolved server-side" — called once, from `CustomerAuthService.
   * verifyOtp()`, immediately after the referred customer's Customer
   * row is created. An unknown/inactive code, or an attempt to refer
   * oneself, is silently a no-op (account creation always succeeds
   * regardless — a bad referral code is never a signup blocker); BR-109's
   * self-referral case cannot actually occur here in practice (a
   * brand-new `referredCustomerId` can never equal any existing code's
   * `customerId`), but the database CHECK constraint is the real
   * enforcement layer regardless of what this method does.
   * Returns whether attribution succeeded, purely for UI feedback.
   */
  async attributeAtSignup(referredCustomerId: string, referralCodeInput?: string): Promise<boolean> {
    if (!referralCodeInput) return false;

    const code = await this.referrals.findActiveCode(referralCodeInput.trim().toUpperCase());
    if (!code || code.customerId === referredCustomerId) return false;

    try {
      await this.referrals.create({
        referrerCustomerId: code.customerId,
        referredCustomerId,
        referralCode: code.code,
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        return false; // BR-108: already has a referrer (should not happen for a brand-new customer, but never fatal).
      }
      throw error;
    }
  }

  /**
   * BR-111: "a referral qualifies only when the referred customer's
   * first order reaches DELIVERED." Called from the same
   * `ORDER_DELIVERED` handler `LoyaltyEarnService.awardForDeliveredOrder`
   * runs from — a no-op for the overwhelmingly common case (most
   * DELIVERED orders belong to a customer nobody referred, or one who
   * has already qualified/been rewarded).
   */
  async qualifyOnDelivered(order: Order): Promise<void> {
    const referral = await this.referrals.findByReferredCustomerId(order.customerId);
    if (!referral || referral.status !== 'PENDING') return;

    const deliveredCount = await this.prisma.order.count({
      where: { customerId: order.customerId, status: 'DELIVERED' },
    });
    if (deliveredCount !== 1) return; // not their first delivered order.

    const qualified = await this.referrals.updateStatus(referral.id, 'QUALIFIED', {
      qualifyingOrderId: order.id,
      qualifiedAt: new Date(),
    });

    // BR-112: idempotent via the ledger's own uniqueness — a reward is
    // issued once per referral, keyed by the referral's own id.
    // BR-114: this runs strictly after the order's own transaction has
    // already committed (this whole method is a post-commit outbox
    // handler); a failure here can never roll back the qualifying order.
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.ledger.create(tx, {
          customerId: qualified.referrerCustomerId,
          type: 'REFERRAL_REWARD',
          points: REFERRAL_REWARD_POINTS,
          referenceType: 'Referral',
          referenceId: qualified.id,
          description: `Referral reward for referring order ${order.orderNumber}`,
        });
        await this.accounts.applyDelta(tx, qualified.referrerCustomerId, {
          balancePoints: REFERRAL_REWARD_POINTS,
          lifetimeEarned: REFERRAL_REWARD_POINTS,
        });
      });
      await this.referrals.updateStatus(qualified.id, 'REWARDED', { rewardedAt: new Date() });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      // Reward already issued for this referral (duplicate event) — the
      // referral may still show QUALIFIED rather than REWARDED if a
      // prior attempt crashed between the ledger write and this status
      // update; harmless (the ledger entry is what actually matters).
    }
  }

  /**
   * BR-113: "refund of the qualifying order invalidates the referral
   * and claws back rewards." Mirrors `LoyaltyClawbackService`'s own
   * idempotency shape (keyed by refundId, not orderId — a no-op unless
   * this specific order is some referral's `qualifyingOrderId`).
   */
  async invalidateForRefundedOrder(orderId: string, refundId: string): Promise<void> {
    const referral = await this.referrals.findByQualifyingOrderId(orderId);
    if (!referral || referral.status !== 'REWARDED') return;

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.ledger.create(tx, {
          customerId: referral.referrerCustomerId,
          type: 'REFUND_CLAWBACK',
          points: -REFERRAL_REWARD_POINTS,
          referenceType: 'Refund',
          referenceId: `${refundId}:referral`,
          description: `Referral reward clawback — qualifying order ${orderId} was refunded`,
        });
        await this.accounts.applyDelta(tx, referral.referrerCustomerId, {
          balancePoints: -REFERRAL_REWARD_POINTS,
        });
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
    }
    await this.referrals.updateStatus(referral.id, 'INVALIDATED');
  }
}
