import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';
import { AppError } from '../../../platform/errors/app-error.js';
import { PaymentRepository } from '../repositories/payment.repository.js';
import { WebhookEventRepository } from '../repositories/webhook-event.repository.js';
import { PaymentVerificationService } from './payment-verification.service.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../providers/payment-provider.port.js';

/**
 * `POST /webhooks/razorpay` — the provider callback receiver.
 * docs/02-database-schema.md §6.3's processing contract, followed
 * exactly: verify signature (over the *raw* body, constant-time
 * compare) → INSERT ... ON CONFLICT DO NOTHING (unique
 * `(provider, providerEventId)`) → zero rows inserted means duplicate,
 * stop → otherwise process → controller always answers 200 for a
 * validly-signed, durably-stored event (BR-39, BR-40) — a processing
 * exception is caught here, the event is marked FAILED, but the method
 * still returns normally so the provider is never told to retry a
 * webhook we've already recorded.
 *
 * Once signature-verified, the *provider's own re-fetched status* is
 * what gets applied (`PaymentProvider.fetchPaymentStatus`), not the raw
 * webhook JSON body's embedded fields — this keeps WebhookService
 * provider-agnostic (it never parses Razorpay-specific payload shape
 * beyond the ids `parseWebhookPayload` already normalizes) and is a
 * second, defense-in-depth confirmation directly from the provider's
 * API rather than trusting a webhook body that could, in principle, be
 * malformed by a buggy provider even when correctly signed.
 */
@Injectable()
export class WebhookService {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
    @Inject(WebhookEventRepository) private readonly webhookEvents: WebhookEventRepository,
    @Inject(PaymentRepository) private readonly payments: PaymentRepository,
    @Inject(PaymentVerificationService) private readonly verification: PaymentVerificationService,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  async handle(rawBody: Buffer, signatureHeader: string | undefined): Promise<void> {
    if (!this.paymentProvider.verifyWebhookSignature(rawBody, signatureHeader)) {
      this.logger.warn(
        { provider: this.paymentProvider.name, bodyLength: rawBody.length },
        'Webhook signature verification failed — rejected before any processing or storage',
      );
      // Deliberately not stored in webhook_events: an unverified payload's
      // claimed event id cannot be trusted as a real anchor, and storing
      // it would risk poisoning the dedup constraint for a future
      // genuine event that reuses the same id (BR-38).
      throw new AppError('INVALID_SIGNATURE', 401, 'Webhook signature verification failed.');
    }

    const parsed = this.paymentProvider.parseWebhookPayload(rawBody);

    const stored = await this.webhookEvents.createIfNotExists({
      provider: this.paymentProvider.name,
      providerEventId: parsed.eventId,
      eventType: parsed.eventType,
      signatureValid: true,
      payload: parsed.payload,
    });

    if (!stored) {
      this.logger.info(
        { provider: this.paymentProvider.name, eventId: parsed.eventId },
        'Duplicate webhook event ignored',
      );
      return;
    }

    try {
      const payment = await this.resolvePayment(parsed.providerPaymentId, parsed.providerOrderId);
      if (!payment) {
        await this.webhookEvents.markFailed(stored.id, 'No matching local payment found.');
        this.logger.warn(
          { provider: this.paymentProvider.name, eventId: parsed.eventId },
          'Webhook referenced a payment this system has no record of',
        );
        return;
      }

      if (!parsed.providerPaymentId) {
        // An order-level event with no payment id yet — nothing to fetch/apply.
        await this.webhookEvents.markProcessed(stored.id);
        return;
      }

      const status = await this.paymentProvider.fetchPaymentStatus(parsed.providerPaymentId);
      await this.verification.applyProviderStatus(payment, status);
      await this.webhookEvents.markProcessed(stored.id);
    } catch (error) {
      await this.webhookEvents.markFailed(
        stored.id,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error(
        { err: error, provider: this.paymentProvider.name, eventId: parsed.eventId },
        'Webhook processing failed — event recorded as FAILED, still answering 200',
      );
    }
  }

  private async resolvePayment(providerPaymentId?: string, providerOrderId?: string) {
    if (providerPaymentId) {
      const byPaymentId = await this.payments.findByProviderPaymentId(
        this.paymentProvider.name,
        providerPaymentId,
      );
      if (byPaymentId) return byPaymentId;
    }
    if (providerOrderId) {
      return this.payments.findByProviderOrderId(this.paymentProvider.name, providerOrderId);
    }
    return null;
  }
}
