import { Inject, Injectable } from '@nestjs/common';
import type { Delivery, DeliveryStatus, Order } from '@prisma/client';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';
import { ProviderError } from '../../../platform/errors/app-error.js';
import { DeliveryRepository } from '../repositories/delivery.repository.js';
import {
  DELIVERY_PROVIDER,
  type DeliveryAddress,
  type DeliveryProvider,
  type ProviderDeliveryState,
} from '../providers/delivery-provider.port.js';

/**
 * Triggered directly and synchronously from `RestaurantOrderService.ready()`
 * — no outbox-consumer indirection, mirroring exactly how `reject()`
 * already calls `RefundService.requestRefund()` gated on
 * `result.applied` (Phase 10's established pattern for "structurally
 * exactly-once" cross-aggregate side effects; see that service's own
 * doc comment).
 *
 * `DeliveryRepository.createIfNotExists`'s `@@unique([orderId])` guard
 * is the actual defence against a duplicate dispatch (docs/14-
 * acceptance-criteria.md: "Marking ready twice results in exactly one
 * delivery row") — this service never checks "does a delivery already
 * exist" itself before creating one; it just creates and lets the
 * constraint decide, the same idempotent-insert shape
 * `WebhookEventRepository`/`RefundRepository` already use.
 *
 * A provider failure NEVER propagates out of `dispatch()` — the ready()
 * HTTP call has already committed the order to READY_FOR_PICKUP by the
 * time this runs, and a courier problem must not un-happen that (docs/03
 * §7.4: "a delivery failure never corrupts payment [or order] records").
 * Failures are recorded on the Delivery row and raised through the
 * outbox as a placeholder alert (same "log-and-mark-processed until
 * Phase 12" honesty as every other outbox consumer in this codebase
 * today) rather than thrown.
 */
@Injectable()
export class DeliveryDispatchService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DeliveryRepository) private readonly deliveries: DeliveryRepository,
    @Inject(DELIVERY_PROVIDER) private readonly provider: DeliveryProvider,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  async dispatch(order: Order): Promise<void> {
    const idempotencyKey = `order:${order.id}:delivery`;

    let pickup: { address: DeliveryAddress; businessName: string };
    try {
      pickup = await this.resolvePickupAddress(order.restaurantId);
    } catch (error) {
      this.logger.error(
        { err: error, orderId: order.id, restaurantId: order.restaurantId },
        'Could not resolve restaurant pickup address for delivery dispatch',
      );
      await this.alertCreationFailed(order, error);
      return;
    }

    const created = await this.deliveries.createIfNotExists({
      orderId: order.id,
      provider: this.provider.name,
      pickupAddress: pickup.address,
      dropoffAddress: order.deliveryAddress,
      idempotencyKey,
    });

    if (!created) {
      // Already dispatched — a prior ready() call (or a concurrent
      // racing one) already created the one-and-only Delivery row for
      // this order. Nothing further to do here; a stuck
      // PENDING_CREATION/CREATION_FAILED row is retried through the
      // admin redispatch endpoint (Phase 13), not silently re-attempted
      // on every subsequent idempotent ready() replay.
      return;
    }

    await this.attemptCreate(created, order, pickup);
  }

  private async attemptCreate(
    delivery: Delivery,
    order: Order,
    pickup: { address: DeliveryAddress; businessName: string },
  ): Promise<void> {
    try {
      const quote = await this.provider.createDelivery({
        orderId: order.id,
        orderNumber: order.orderNumber,
        pickupAddress: pickup.address,
        pickupBusinessName: pickup.businessName,
        dropoffAddress: order.deliveryAddress as unknown as DeliveryAddress,
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        idempotencyKey: delivery.idempotencyKey,
      });

      await this.deliveries.update(delivery.id, {
        status: toDeliveryStatus(quote.status),
        providerDeliveryId: quote.providerDeliveryId,
        trackingUrl: quote.trackingUrl,
        quotedFeeMinor: quote.quotedFeeMinor,
        estimatedPickupAt: quote.estimatedPickupAt,
        estimatedDeliveryAt: quote.estimatedDeliveryAt,
        attemptCount: { increment: 1 },
      });
    } catch (error) {
      // Timeout ≠ failure (docs/03-state-machines.md §7.4: "a provider
      // timeout may mean the delivery WAS created; never blindly retry,
      // reconcile by idempotency key or query the provider first") — a
      // 503 leaves status at PENDING_CREATION (ambiguous, reconcilable)
      // rather than CREATION_FAILED (a definite, provider-confirmed
      // rejection, only ever a 502).
      const isTimeout = error instanceof ProviderError && error.httpStatus === 503;
      await this.deliveries.update(delivery.id, {
        status: isTimeout ? 'PENDING_CREATION' : 'CREATION_FAILED',
        failureReason: error instanceof Error ? error.message : String(error),
        attemptCount: { increment: 1 },
      });

      this.logger.error(
        { err: error, orderId: order.id, timeout: isTimeout },
        'Delivery creation failed — order remains READY_FOR_PICKUP, alert recorded',
      );
      await this.alertCreationFailed(order, error, isTimeout);
    }
  }

  private async alertCreationFailed(order: Order, error: unknown, timeout = false): Promise<void> {
    await this.outbox.record(
      'DELIVERY_CREATION_FAILED',
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        timeout,
        reason: error instanceof Error ? error.message : String(error),
      },
      order.restaurantId,
    );
  }

  private async resolvePickupAddress(
    restaurantId: string,
  ): Promise<{ address: DeliveryAddress; businessName: string }> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      include: { address: true },
    });
    if (!restaurant?.address) {
      throw new Error(`Restaurant ${restaurantId} has no pickup address on file.`);
    }
    return {
      businessName: restaurant.name,
      address: {
        line1: restaurant.address.line1,
        locality: restaurant.address.locality ?? undefined,
        city: restaurant.address.city,
        postalCode: restaurant.address.postalCode,
        latitude: restaurant.address.latitude ? Number(restaurant.address.latitude) : undefined,
        longitude: restaurant.address.longitude ? Number(restaurant.address.longitude) : undefined,
      },
    };
  }
}

function toDeliveryStatus(status: ProviderDeliveryState): DeliveryStatus {
  return status;
}
