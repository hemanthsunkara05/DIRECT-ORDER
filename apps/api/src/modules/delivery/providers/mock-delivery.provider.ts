import { randomUUID, createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ProviderError } from '../../../platform/errors/app-error.js';
import { verifyHmacSignature } from '../../payments/providers/mock-payment.provider.js';
import type {
  CreateDeliveryInput,
  DeliveryProvider,
  DeliveryQuote,
  ParsedDeliveryWebhookEvent,
  ProviderDeliveryState,
  ProviderDeliveryStatus,
} from './delivery-provider.port.js';

/** Not a real secret — this provider only ever runs against itself, never a live network. Fixed so signed test payloads are reproducible. */
const MOCK_WEBHOOK_SECRET = 'mock-delivery-webhook-secret-for-local-dev-and-tests';

interface MockDeliveryRecord {
  providerDeliveryId: string;
  orderId: string;
  status: ProviderDeliveryState;
  trackingUrl: string;
  quotedFeeMinor: bigint;
  courierName?: string;
  courierPhone?: string;
  actualFeeMinor?: bigint;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  failureReason?: string;
}

/**
 * A fully-working in-memory delivery simulator — the default provider
 * (`DELIVERY_PROVIDER=mock`) for local dev and every automated test in
 * this sandbox, which has no live Uber Direct access to begin with
 * (RISK-3: "self-serve access in Bengaluru unconfirmed").
 *
 * Reuses `verifyHmacSignature` from the payments module (Phase 9) — the
 * same HMAC-SHA256-over-raw-body, constant-time-compare scheme, just a
 * different fixed test secret, so the security-critical verification
 * code path is exercised for real in delivery webhook tests too, not
 * duplicated.
 *
 * `forceOutcome()` and `advanceStatus()` are the two methods outside the
 * `DeliveryProvider` interface — the delivery equivalent of
 * `MockPaymentProvider.simulatePaymentOutcome()`. Tests call them
 * directly (via this concrete class, not the `DELIVERY_PROVIDER` token)
 * to drive a delivery through REJECT/TIMEOUT on creation, or forward
 * through SEARCHING_COURIER → ... → DELIVERED, since there is no real
 * courier here to do it.
 */
@Injectable()
export class MockDeliveryProvider implements DeliveryProvider {
  // Deliberately NOT 'mock' — MockPaymentProvider already claims that
  // string, and (provider, providerEventId) is the WebhookEvent
  // dedup/idempotency key (docs/02-database-schema.md §6.3): two
  // unrelated integrations sharing one `provider` identity would defeat
  // the point of that key being provider-specific. Matches the
  // `Delivery` model's own doc comment in schema.prisma.
  readonly name = 'mock_delivery';

  private readonly byDeliveryId = new Map<string, MockDeliveryRecord>();
  /** orderId -> forced outcome for the NEXT createDelivery() call for that order, consumed once. */
  private readonly forcedOutcomes = new Map<string, 'REJECT' | 'TIMEOUT'>();

  async createDelivery(input: CreateDeliveryInput): Promise<DeliveryQuote> {
    const forced = this.forcedOutcomes.get(input.orderId);
    if (forced) {
      this.forcedOutcomes.delete(input.orderId);
      if (forced === 'REJECT') {
        // Definite rejection — the caller must NOT retry blindly and must
        // NOT mark the order out for delivery (docs/14-acceptance-
        // criteria.md: "Provider rejection leaves the order not marked
        // out for delivery and alerts restaurant and admin").
        throw new ProviderError(
          'MockDeliveryProvider: delivery rejected (no courier zone coverage)',
          502,
        );
      }
      // TIMEOUT: ambiguous — may have actually succeeded provider-side.
      // docs/03-state-machines.md §7.4: "Timeout ≠ failure... never
      // blindly retry, reconcile by idempotency key or query the
      // provider first." 503 signals "unknown, do not assume failure."
      throw new ProviderError('MockDeliveryProvider: request timed out', 503);
    }

    const providerDeliveryId = `mock_delivery_${randomUUID()}`;
    const record: MockDeliveryRecord = {
      providerDeliveryId,
      orderId: input.orderId,
      status: 'CREATED',
      trackingUrl: `https://mock-delivery.local/track/${providerDeliveryId}`,
      quotedFeeMinor: 4000n,
    };
    this.byDeliveryId.set(providerDeliveryId, record);

    return Promise.resolve({
      providerDeliveryId,
      status: record.status,
      trackingUrl: record.trackingUrl,
      quotedFeeMinor: record.quotedFeeMinor,
      estimatedPickupAt: new Date(Date.now() + 15 * 60_000),
      estimatedDeliveryAt: new Date(Date.now() + 40 * 60_000),
    });
  }

  async fetchDeliveryStatus(providerDeliveryId: string): Promise<ProviderDeliveryStatus> {
    const record = this.byDeliveryId.get(providerDeliveryId);
    if (!record) {
      throw new ProviderError(`Unknown provider delivery id: ${providerDeliveryId}`, 502);
    }
    return Promise.resolve({
      providerDeliveryId,
      status: record.status,
      courierName: record.courierName,
      courierPhone: record.courierPhone,
      trackingUrl: record.trackingUrl,
      actualFeeMinor: record.actualFeeMinor,
      pickedUpAt: record.pickedUpAt,
      deliveredAt: record.deliveredAt,
      failureReason: record.failureReason,
    });
  }

  async cancelDelivery(providerDeliveryId: string, reason: string): Promise<void> {
    const record = this.byDeliveryId.get(providerDeliveryId);
    if (!record) {
      throw new ProviderError(`Unknown provider delivery id: ${providerDeliveryId}`, 502);
    }
    record.status = 'CANCELLED';
    record.failureReason = reason;
    return Promise.resolve();
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    return verifyHmacSignature(rawBody, signatureHeader, MOCK_WEBHOOK_SECRET);
  }

  parseWebhookPayload(rawBody: Buffer): ParsedDeliveryWebhookEvent {
    const parsed = JSON.parse(rawBody.toString('utf8')) as {
      id: string;
      event: string;
      delivery_id?: string;
    };
    return {
      eventId: parsed.id,
      eventType: parsed.event,
      providerDeliveryId: parsed.delivery_id,
      payload: parsed,
    };
  }

  /** Forces the NEXT createDelivery() call for this orderId to reject or time out — consumed once. */
  forceOutcome(orderId: string, outcome: 'REJECT' | 'TIMEOUT'): void {
    this.forcedOutcomes.set(orderId, outcome);
  }

  /**
   * Moves a delivery to an arbitrary status, standing in for courier
   * app updates a real integration would push via webhook. Setting
   * courier fields on first assignment mirrors how a real provider
   * only knows the courier's name/phone once one is actually assigned.
   */
  advanceStatus(
    providerDeliveryId: string,
    status: ProviderDeliveryState,
    options: { courierName?: string; courierPhone?: string; failureReason?: string } = {},
  ): void {
    const record = this.byDeliveryId.get(providerDeliveryId);
    if (!record) {
      throw new Error(`MockDeliveryProvider: unknown providerDeliveryId ${providerDeliveryId}`);
    }
    record.status = status;
    if (options.courierName) record.courierName = options.courierName;
    if (options.courierPhone) record.courierPhone = options.courierPhone;
    if (options.failureReason) record.failureReason = options.failureReason;
    if (status === 'PICKED_UP') record.pickedUpAt = new Date();
    if (status === 'DELIVERED') {
      record.deliveredAt = new Date();
      record.actualFeeMinor = record.quotedFeeMinor;
    }
  }

  /** Builds a realistic, correctly-signed webhook body — tests POST this straight to the real webhook endpoint to exercise raw-body verification end-to-end. */
  signWebhookBody(eventType: string, providerDeliveryId: string): Buffer {
    const body = {
      id: `mock_delivery_evt_${randomUUID()}`,
      event: eventType,
      delivery_id: providerDeliveryId,
    };
    return Buffer.from(JSON.stringify(body), 'utf8');
  }

  signature(rawBody: Buffer): string {
    return createHmac('sha256', MOCK_WEBHOOK_SECRET).update(rawBody).digest('hex');
  }
}
