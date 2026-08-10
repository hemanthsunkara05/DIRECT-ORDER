import { Inject, Injectable } from '@nestjs/common';
import type { Delivery, DeliveryStatus } from '@prisma/client';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';
import { AppError } from '../../../platform/errors/app-error.js';
import { WebhookEventRepository } from '../../payments/repositories/webhook-event.repository.js';
import { OrderRepository } from '../../orders/repositories/order.repository.js';
import { OrderStateService } from '../../orders/services/order-state.service.js';
import { DeliveryRepository } from '../repositories/delivery.repository.js';
import {
  DELIVERY_PROVIDER,
  type DeliveryProvider,
  type ProviderDeliveryState,
  type ProviderDeliveryStatus,
} from '../providers/delivery-provider.port.js';

/**
 * A delivery's rank in the happy-path progression — used to detect
 * regressions ("DELIVERED → PICKED_UP" — docs/03-state-machines.md
 * §7.4: "regressions... are ignored") and out-of-order jumps
 * ("DELIVERED before PICKED_UP" — "apply the terminal state, record the
 * anomaly, don't error"). The four failure/terminal outcomes all rank
 * above every in-flight state: once any of them lands, nothing else can
 * supersede it (`DELIVERED/CANCELLED/FAILED/NO_COURIER_FOUND --> [*]`,
 * no outbound edges in the state diagram).
 */
const DELIVERY_RANK: Record<ProviderDeliveryState, number> = {
  CREATED: 1,
  SEARCHING_COURIER: 2,
  COURIER_ASSIGNED: 3,
  AT_PICKUP: 4,
  PICKED_UP: 5,
  DELIVERED: 6,
  NO_COURIER_FOUND: 6,
  CANCELLED: 6,
  FAILED: 6,
};

const TERMINAL: ReadonlySet<DeliveryStatus> = new Set([
  'DELIVERED',
  'CANCELLED',
  'FAILED',
  'NO_COURIER_FOUND',
]);

/**
 * `POST /webhooks/delivery/:provider` — the delivery-side counterpart
 * of `WebhookService` (Phase 9), same processing contract: verify
 * signature over the raw body → `createIfNotExists` (the idempotency
 * anchor; a P2002 on `(provider, providerEventId)` means duplicate,
 * stop) → apply → always answer 200 for a validly-signed, durably-
 * stored event, even when processing itself failed (BR-39/BR-40 — see
 * `WebhookService`'s own doc comment for the full rationale, reused
 * verbatim here).
 *
 * Reuses `WebhookEventRepository` — the `Delivery` model's own doc
 * comment in schema.prisma explains why this doesn't get a second,
 * parallel `delivery_events` table.
 */
@Injectable()
export class DeliveryWebhookService {
  constructor(
    @Inject(DELIVERY_PROVIDER) private readonly provider: DeliveryProvider,
    @Inject(WebhookEventRepository) private readonly webhookEvents: WebhookEventRepository,
    @Inject(DeliveryRepository) private readonly deliveries: DeliveryRepository,
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(OrderStateService) private readonly orderState: OrderStateService,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  async handle(rawBody: Buffer, signatureHeader: string | undefined): Promise<void> {
    if (!this.provider.verifyWebhookSignature(rawBody, signatureHeader)) {
      this.logger.warn(
        { provider: this.provider.name, bodyLength: rawBody.length },
        'Delivery webhook signature verification failed — rejected before any processing or storage',
      );
      // Not stored — same reasoning as WebhookService: an unverified
      // payload's claimed event id cannot be trusted as a dedup anchor.
      throw new AppError('INVALID_SIGNATURE', 401, 'Webhook signature verification failed.');
    }

    const parsed = this.provider.parseWebhookPayload(rawBody);

    const stored = await this.webhookEvents.createIfNotExists({
      provider: this.provider.name,
      providerEventId: parsed.eventId,
      eventType: parsed.eventType,
      signatureValid: true,
      payload: parsed.payload,
    });

    if (!stored) {
      this.logger.info(
        { provider: this.provider.name, eventId: parsed.eventId },
        'Duplicate delivery webhook event ignored',
      );
      return;
    }

    try {
      if (!parsed.providerDeliveryId) {
        await this.webhookEvents.markProcessed(stored.id);
        return;
      }

      const delivery = await this.deliveries.findByProviderDeliveryId(
        this.provider.name,
        parsed.providerDeliveryId,
      );
      if (!delivery) {
        await this.webhookEvents.markFailed(stored.id, 'No matching local delivery found.');
        this.logger.warn(
          { provider: this.provider.name, eventId: parsed.eventId },
          'Delivery webhook referenced a delivery this system has no record of',
        );
        return;
      }

      const status = await this.provider.fetchDeliveryStatus(parsed.providerDeliveryId);
      await this.applyStatus(delivery, status);
      await this.webhookEvents.markProcessed(stored.id);
    } catch (error) {
      await this.webhookEvents.markFailed(
        stored.id,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(
        { err: error, provider: this.provider.name, eventId: parsed.eventId },
        'Delivery webhook processing failed — event recorded as FAILED, still answering 200',
      );
    }
  }

  private async applyStatus(delivery: Delivery, status: ProviderDeliveryStatus): Promise<void> {
    if (TERMINAL.has(delivery.status)) {
      // The state diagram draws no outbound edge from any terminal
      // status — a stray/duplicate event arriving after DELIVERED (or
      // any other terminal outcome) is a no-op, not an error.
      this.logger.info(
        { deliveryId: delivery.id, currentStatus: delivery.status, reportedStatus: status.status },
        'Delivery webhook event ignored — delivery already in a terminal state',
      );
      return;
    }

    const currentRank = DELIVERY_RANK[delivery.status as ProviderDeliveryState] ?? 0;
    const nextRank = DELIVERY_RANK[status.status];

    if (nextRank < currentRank) {
      this.logger.warn(
        { deliveryId: delivery.id, currentStatus: delivery.status, reportedStatus: status.status },
        'Delivery webhook reported a regression — ignored',
      );
      return;
    }

    if (nextRank > currentRank + 1) {
      this.logger.warn(
        { deliveryId: delivery.id, currentStatus: delivery.status, reportedStatus: status.status },
        'Delivery webhook event arrived out of order — applying the reported state directly',
      );
    }

    await this.deliveries.update(delivery.id, {
      status: status.status,
      courierName: status.courierName,
      courierPhone: status.courierPhone,
      trackingUrl: status.trackingUrl,
      actualFeeMinor: status.actualFeeMinor,
      pickedUpAt: status.status === 'PICKED_UP' ? (status.pickedUpAt ?? new Date()) : undefined,
      deliveredAt: status.status === 'DELIVERED' ? (status.deliveredAt ?? new Date()) : undefined,
      failureReason: status.failureReason,
    });

    await this.coupleOrderState(delivery.orderId, status.status);
  }

  /**
   * docs/03-state-machines.md §7.4: "Order coupling: delivery state
   * drives order state ONLY for READY_FOR_PICKUP → OUT_FOR_DELIVERY →
   * DELIVERED." `OrderStateService.transition()` only ever allows one
   * hop, and is itself idempotent-replay-safe (a call to move an order
   * that is already at the target status returns `applied: false`
   * rather than erroring) — so routing every courier-assigned-or-later
   * event through `OUT_FOR_DELIVERY` first, THEN the real target when
   * that differs, is what lets a single webhook (e.g. an out-of-order
   * DELIVERED arriving while the order is still READY_FOR_PICKUP)
   * safely walk both hops without the caller needing to know which one
   * was already applied. `CANCELLED` has no order-state edge in that
   * coupling rule — a cancelled delivery does not by itself cancel the
   * order; that remains a separate restaurant/admin action.
   */
  private async coupleOrderState(orderId: string, status: ProviderDeliveryState): Promise<void> {
    const order = await this.orders.findById(orderId);
    if (!order) return;

    if (status === 'COURIER_ASSIGNED' || status === 'AT_PICKUP' || status === 'PICKED_UP') {
      await this.orderState.transition(orderId, 'OUT_FOR_DELIVERY', { type: 'SYSTEM' });
      return;
    }

    if (status === 'DELIVERED') {
      await this.orderState.transition(orderId, 'OUT_FOR_DELIVERY', { type: 'SYSTEM' });
      await this.orderState.transition(orderId, 'DELIVERED', { type: 'SYSTEM' });
      return;
    }

    if (status === 'FAILED' || status === 'NO_COURIER_FOUND') {
      // An attempted delivery that failed is "went out and failed," not
      // "was cancelled" — DELIVERY_FAILED is only a legal target from
      // OUT_FOR_DELIVERY (ORDER_TRANSITIONS), so this ensures that hop
      // first, exactly like the DELIVERED case above.
      await this.orderState.transition(orderId, 'OUT_FOR_DELIVERY', { type: 'SYSTEM' });
      await this.orderState.transition(
        orderId,
        'DELIVERY_FAILED',
        { type: 'SYSTEM' },
        {
          reason: `Delivery ${status === 'NO_COURIER_FOUND' ? 'found no available courier' : 'failed'}.`,
        },
      );
    }
  }
}
