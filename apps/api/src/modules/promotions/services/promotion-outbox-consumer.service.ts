import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';

/**
 * Confirms or releases a coupon reservation off the SAME outbox relay
 * every other Phase 12+ consumer attaches to (`OutboxService.
 * registerConsumer()`, a runtime method call, not a DI import in
 * either direction — `platform/outbox` must never import a domain
 * module, docs/12-repository-structure.md) — no second poller.
 *
 * `updateMany({ where: { orderId, status: 'RESERVED' } })` is a no-op
 * (0 rows) for the overwhelmingly common case of an order with no
 * coupon at all, and — just as importantly — for BR-90 ("order
 * cancellation after payment does NOT return coupon usage"): a
 * CONFIRMED redemption's status is never RESERVED any more, so it is
 * structurally untouched by `release`, and there is no handler
 * registered for ORDER_CANCELLED/ORDER_REJECTED/ORDER_DELIVERED at
 * all — a CONFIRMED redemption simply stays CONFIRMED forever.
 */
@Injectable()
export class PromotionOutboxConsumer implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    this.outbox.registerConsumer((event) => this.handle(event));
  }

  async handle(event: OutboxEvent): Promise<void> {
    if (event.eventType === 'ORDER_PLACED') {
      await this.confirm(event.payload);
    } else if (event.eventType === 'ORDER_PAYMENT_FAILED' || event.eventType === 'ORDER_EXPIRED') {
      await this.release(event.payload);
    }
  }

  private async confirm(payload: unknown): Promise<void> {
    const orderId = extractOrderId(payload);
    if (!orderId) return;
    await this.prisma.promotionRedemption.updateMany({
      where: { orderId, status: 'RESERVED' },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });
  }

  private async release(payload: unknown): Promise<void> {
    const orderId = extractOrderId(payload);
    if (!orderId) return;
    await this.prisma.promotionRedemption.updateMany({
      where: { orderId, status: 'RESERVED' },
      data: { status: 'RELEASED' },
    });
  }
}

function extractOrderId(payload: unknown): string | undefined {
  return (payload as { orderId?: string }).orderId;
}
