import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ProviderError } from '../../../platform/errors/app-error.js';
import type {
  CreatePaymentIntentInput,
  CreateRefundInput,
  ParsedWebhookEvent,
  PaymentIntent,
  PaymentProvider,
  ProviderPaymentState,
  ProviderPaymentStatus,
  ProviderRefundResult,
} from './payment-provider.port.js';

/** Not a real secret — this provider only ever runs against itself, never a live network. Fixed so signed test payloads are reproducible. */
const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret-for-local-dev-and-tests';

interface MockPaymentRecord {
  providerOrderId: string;
  providerPaymentId: string | null;
  orderId: string;
  amountMinor: bigint;
  currency: string;
  status: ProviderPaymentState;
  method?: string;
  failureCode?: string;
  failureMessage?: string;
}

/**
 * A fully-working in-memory payment simulator — the default provider
 * (`PAYMENT_PROVIDER=mock`) for local dev and every automated test in
 * this sandbox, which has no live network access to a real payment
 * provider and, per AMB-3 (payment settlement structure, explicitly
 * BLOCKING / REQUIRES PRODUCT DECISION), must never move real money on
 * an assumption anyway.
 *
 * Uses the exact same HMAC-SHA256-over-raw-body webhook scheme
 * `RazorpayPaymentProvider` uses (with a fixed, non-secret test key) so
 * the security-critical signature-verification code path is exercised
 * for real in tests, not bypassed — see `signWebhookBody()`.
 *
 * `simulatePaymentOutcome()` is the one method outside the
 * `PaymentProvider` interface — it stands in for "the customer
 * completed (or abandoned) Razorpay Checkout," which has no equivalent
 * without a real provider. Tests and the local-dev checkout flow call
 * it directly (via this concrete class, not the `PAYMENT_PROVIDER`
 * token) to drive a payment to CAPTURED or FAILED.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  private readonly byOrderId = new Map<string, MockPaymentRecord>();
  private readonly byPaymentId = new Map<string, MockPaymentRecord>();

  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntent> {
    const providerOrderId = `mock_order_${randomUUID()}`;
    const record: MockPaymentRecord = {
      providerOrderId,
      providerPaymentId: null,
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: 'CREATED',
    };
    this.byOrderId.set(providerOrderId, record);

    return Promise.resolve({
      providerOrderId,
      providerPublicKey: 'mock_public_key',
      amountMinor: input.amountMinor,
      currency: input.currency,
    });
  }

  async fetchPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentStatus> {
    const record = this.byPaymentId.get(providerPaymentId);
    if (!record) {
      // A real Razorpay lookup against an unknown id fails the same way
      // `RazorpayPaymentProvider.request()` already reports every
      // provider-side failure — a typed `ProviderError`, never a bare
      // `Error` that would otherwise surface to the client as an opaque
      // 500 with no code the frontend could branch on (found live,
      // against real Postgres, during this phase's manual verification —
      // a client-supplied `providerPaymentId` hint that doesn't match
      // anything is a real, reachable case, not just a theoretical one).
      throw new ProviderError(`Unknown provider payment id: ${providerPaymentId}`, 502);
    }
    return Promise.resolve({
      providerPaymentId,
      providerOrderId: record.providerOrderId,
      status: record.status,
      amountMinor: record.amountMinor,
      currency: record.currency,
      method: record.method,
      failureCode: record.failureCode,
      failureMessage: record.failureMessage,
    });
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    return verifyHmacSignature(rawBody, signatureHeader, MOCK_WEBHOOK_SECRET);
  }

  parseWebhookPayload(rawBody: Buffer): ParsedWebhookEvent {
    const parsed = JSON.parse(rawBody.toString('utf8')) as {
      id: string;
      event: string;
      payload?: { payment?: { entity?: { id?: string; order_id?: string } } };
    };
    return {
      eventId: parsed.id,
      eventType: parsed.event,
      providerPaymentId: parsed.payload?.payment?.entity?.id,
      providerOrderId: parsed.payload?.payment?.entity?.order_id,
      payload: parsed,
    };
  }

  async createRefund(input: CreateRefundInput): Promise<ProviderRefundResult> {
    const record = this.byPaymentId.get(input.providerPaymentId);
    if (!record) {
      throw new ProviderError(`Unknown provider payment id: ${input.providerPaymentId}`, 502);
    }
    return Promise.resolve({
      providerRefundId: `mock_refund_${randomUUID()}`,
      status: 'COMPLETED',
    });
  }

  /**
   * Drives a created payment intent to CAPTURED or FAILED — the mock
   * stand-in for "the customer completed (or abandoned) Razorpay
   * Checkout." Assigns a `providerPaymentId` only on CAPTURED, matching
   * how a real provider never issues a payment id for an attempt that
   * never actually authorized.
   */
  simulatePaymentOutcome(
    providerOrderId: string,
    outcome: 'CAPTURED' | 'FAILED',
    options: { failureCode?: string; failureMessage?: string; amountMinor?: bigint } = {},
  ): { providerPaymentId: string | null } {
    const record = this.byOrderId.get(providerOrderId);
    if (!record) {
      throw new Error(`MockPaymentProvider: unknown providerOrderId ${providerOrderId}`);
    }

    if (outcome === 'CAPTURED') {
      const providerPaymentId = `mock_pay_${randomUUID()}`;
      record.providerPaymentId = providerPaymentId;
      record.status = 'CAPTURED';
      record.method = 'card';
      // options.amountMinor lets a test simulate a provider/backend amount mismatch deliberately.
      if (options.amountMinor !== undefined) record.amountMinor = options.amountMinor;
      this.byPaymentId.set(providerPaymentId, record);
      return { providerPaymentId };
    }

    record.status = 'FAILED';
    record.failureCode = options.failureCode ?? 'PAYMENT_DECLINED';
    record.failureMessage = options.failureMessage ?? 'The payment was declined.';
    return { providerPaymentId: null };
  }

  /** Builds a realistic, correctly-signed webhook body — tests POST this straight to the real webhook endpoint to exercise raw-body verification end-to-end. */
  signWebhookBody(eventType: string, providerPaymentId: string, providerOrderId: string): Buffer {
    const record = this.byPaymentId.get(providerPaymentId);
    const body = {
      id: `mock_evt_${randomUUID()}`,
      event: eventType,
      payload: {
        payment: {
          entity: {
            id: providerPaymentId,
            order_id: providerOrderId,
            amount: record ? Number(record.amountMinor) : 0,
            currency: record?.currency ?? 'INR',
            status: record?.status.toLowerCase() ?? 'captured',
          },
        },
      },
    };
    return Buffer.from(JSON.stringify(body), 'utf8');
  }

  signature(rawBody: Buffer): string {
    return createHmac('sha256', MOCK_WEBHOOK_SECRET).update(rawBody).digest('hex');
  }
}

/**
 * Shared by both providers — the same HMAC-SHA256-over-raw-body,
 * constant-time-compare scheme Razorpay actually uses (BR-38,
 * docs/09-security.md §15: "HMAC over the raw body before parsing.
 * Constant-time comparison").
 */
export function verifyHmacSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
