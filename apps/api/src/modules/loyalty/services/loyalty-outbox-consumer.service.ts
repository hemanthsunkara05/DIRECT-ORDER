import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';
import { OrderRepository } from '../../orders/repositories/order.repository.js';
import { LoyaltyEarnService } from './loyalty-earn.service.js';
import { LoyaltyRedemptionService } from './loyalty-redemption.service.js';
import { LoyaltyClawbackService } from './loyalty-clawback.service.js';
import { ReferralService } from './referral.service.js';

/**
 * Attaches to the SAME outbox relay every Phase 12+ consumer uses
 * (`OutboxService.registerConsumer()`, a runtime method call, never a
 * DI import in either direction) — see `PromotionOutboxConsumer` for
 * the original statement of this pattern. Five event types drive six
 * distinct effects:
 *
 *   ORDER_DELIVERED       -> LoyaltyEarnService.awardForDeliveredOrder
 *                             + ReferralService.qualifyOnDelivered
 *   ORDER_PLACED           -> LoyaltyRedemptionService.confirm
 *   ORDER_PAYMENT_FAILED,
 *   ORDER_EXPIRED           -> LoyaltyRedemptionService.release
 *   REFUND_COMPLETED       -> LoyaltyClawbackService.clawbackForRefund
 *                             + ReferralService.invalidateForRefundedOrder
 *
 * BR-105 ("cancelled orders earn no points") holds by construction —
 * there is no handler for ORDER_CANCELLED/ORDER_REJECTED at all, the
 * same "structurally absent, not a runtime guard" treatment Phase 14
 * gave BR-90.
 */
@Injectable()
export class LoyaltyOutboxConsumer implements OnModuleInit {
  constructor(
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(LoyaltyEarnService) private readonly earn: LoyaltyEarnService,
    @Inject(LoyaltyRedemptionService) private readonly redemptions: LoyaltyRedemptionService,
    @Inject(LoyaltyClawbackService) private readonly clawback: LoyaltyClawbackService,
    @Inject(ReferralService) private readonly referrals: ReferralService,
  ) {}

  onModuleInit(): void {
    this.outbox.registerConsumer((event) => this.handle(event));
  }

  async handle(event: OutboxEvent): Promise<void> {
    switch (event.eventType) {
      case 'ORDER_DELIVERED': {
        const orderId = extractOrderId(event.payload);
        if (!orderId) return;
        const order = await this.orders.findById(orderId);
        if (!order) return;
        await this.earn.awardForDeliveredOrder(order);
        await this.referrals.qualifyOnDelivered(order);
        return;
      }
      case 'ORDER_PLACED': {
        const orderId = extractOrderId(event.payload);
        if (orderId) await this.redemptions.confirm(orderId);
        return;
      }
      case 'ORDER_PAYMENT_FAILED':
      case 'ORDER_EXPIRED': {
        const orderId = extractOrderId(event.payload);
        if (orderId) await this.redemptions.release(orderId);
        return;
      }
      case 'REFUND_COMPLETED': {
        const payload = event.payload as {
          refundId?: string;
          paymentId?: string;
          amountMinor?: string;
        };
        if (!payload.refundId || !payload.paymentId || !payload.amountMinor) return;
        const orderId = await this.clawback.clawbackForRefund(
          payload.refundId,
          payload.paymentId,
          BigInt(payload.amountMinor),
        );
        if (orderId) {
          await this.referrals.invalidateForRefundedOrder(orderId, payload.refundId);
        }
        return;
      }
      default:
        return;
    }
  }
}

function extractOrderId(payload: unknown): string | undefined {
  return (payload as { orderId?: string }).orderId;
}
