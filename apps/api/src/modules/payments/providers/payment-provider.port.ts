/**
 * The one abstraction every payment code path depends on — checkout,
 * webhook processing, and refunds all go through whichever
 * implementation is bound to `PAYMENT_PROVIDER` (Phase 9,
 * docs/13-implementation-phases.md: "PaymentProvider interface,
 * Razorpay adapter, payment intent creation"). Mirrors the same
 * port/adapter shape already established by `StoragePort` (Phase 5)
 * and the delivery-provider interface planned for Phase 11.
 */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface CreatePaymentIntentInput {
  /** Our own order id — never sent as-is to the provider dashboard; `receipt` is what a human sees there. */
  orderId: string;
  amountMinor: bigint;
  currency: string;
  /** Human-readable reference shown in the provider's dashboard — the order number. */
  receipt: string;
}

export interface PaymentIntent {
  providerOrderId: string;
  /** The provider's *public* key — safe to send to the browser (BR-45: provider credentials never reach the browser refers to the *secret*, not this). */
  providerPublicKey: string;
  amountMinor: bigint;
  currency: string;
}

export type ProviderPaymentState = 'CREATED' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED';

export interface ProviderPaymentStatus {
  providerPaymentId: string;
  providerOrderId: string;
  status: ProviderPaymentState;
  amountMinor: bigint;
  currency: string;
  method?: string;
  failureCode?: string;
  failureMessage?: string;
}

export interface ParsedWebhookEvent {
  eventId: string;
  eventType: string;
  /** The provider's own payment/order identifiers embedded in the event, when present. */
  providerPaymentId?: string;
  providerOrderId?: string;
  payload: unknown;
}

export interface CreateRefundInput {
  providerPaymentId: string;
  amountMinor: bigint;
  /** Passed through to the provider so a retried request against the same refund is itself idempotent on their side too. */
  idempotencyKey: string;
}

export type ProviderRefundState = 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface ProviderRefundResult {
  providerRefundId: string;
  status: ProviderRefundState;
}

export interface PaymentProvider {
  readonly name: string;

  createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntent>;

  /** Server-side status fetch — the only source of truth (BR-37: a frontend callback never sets state directly). */
  fetchPaymentStatus(providerPaymentId: string): Promise<ProviderPaymentStatus>;

  /** HMAC over the *raw* body, constant-time compare (BR-38, docs/09-security.md §15). */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;

  parseWebhookPayload(rawBody: Buffer): ParsedWebhookEvent;

  createRefund(input: CreateRefundInput): Promise<ProviderRefundResult>;
}
