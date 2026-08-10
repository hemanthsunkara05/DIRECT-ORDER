/**
 * The delivery-side counterpart of `PaymentProvider` (Phase 9) — same
 * port/adapter shape, same reasons (`payments/providers/payment-
 * provider.port.ts`'s own doc comment): a `MockDeliveryProvider`
 * (default, fully-working, no live network) and a `UberDirectProvider`
 * (real REST calls, unverified against the live API — RISK-3, docs/15-
 * ambiguities-and-risks.md: "Uber Direct self-serve access in
 * Bengaluru unconfirmed... never claim production delivery when
 * mocked").
 */
export const DELIVERY_PROVIDER = Symbol('DELIVERY_PROVIDER');

export interface DeliveryAddress {
  line1: string;
  locality?: string;
  city: string;
  postalCode: string;
  latitude?: number;
  longitude?: number;
}

export interface CreateDeliveryInput {
  /** Our own order id — never sent as-is to the provider dashboard; `orderNumber` is what a human sees there. */
  orderId: string;
  orderNumber: string;
  pickupAddress: DeliveryAddress;
  pickupBusinessName: string;
  dropoffAddress: DeliveryAddress;
  customerName: string;
  customerPhone: string;
  /** Passed through to the provider so a retried request is itself idempotent on their side too (same pattern as CreatePaymentIntentInput/CreateRefundInput). */
  idempotencyKey: string;
}

/** The subset of DeliveryStatus a provider actually reports back — `PENDING_CREATION` is a local-only state before any provider call has succeeded. */
export type ProviderDeliveryState =
  | 'CREATED'
  | 'SEARCHING_COURIER'
  | 'COURIER_ASSIGNED'
  | 'AT_PICKUP'
  | 'PICKED_UP'
  | 'DELIVERED'
  | 'NO_COURIER_FOUND'
  | 'CANCELLED'
  | 'FAILED';

export interface DeliveryQuote {
  providerDeliveryId: string;
  status: ProviderDeliveryState;
  trackingUrl?: string;
  quotedFeeMinor?: bigint;
  estimatedPickupAt?: Date;
  estimatedDeliveryAt?: Date;
}

export interface ProviderDeliveryStatus {
  providerDeliveryId: string;
  status: ProviderDeliveryState;
  courierName?: string;
  courierPhone?: string;
  trackingUrl?: string;
  actualFeeMinor?: bigint;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  failureReason?: string;
}

export interface ParsedDeliveryWebhookEvent {
  eventId: string;
  eventType: string;
  providerDeliveryId?: string;
  payload: unknown;
}

export interface DeliveryProvider {
  readonly name: string;

  /**
   * Timeout vs. rejection matter differently to the caller (docs/03-
   * state-machines.md §7.4: "Timeout ≠ failure... never blindly
   * retry") — implementations throw `ProviderError` with `503` for an
   * ambiguous/timeout failure (may have actually succeeded on the
   * provider's side) and `502` for a definite rejection, so
   * `DeliveryDispatchService` can tell them apart.
   */
  createDelivery(input: CreateDeliveryInput): Promise<DeliveryQuote>;

  fetchDeliveryStatus(providerDeliveryId: string): Promise<ProviderDeliveryStatus>;

  cancelDelivery(providerDeliveryId: string, reason: string): Promise<void>;

  /** HMAC over the *raw* body, constant-time compare — same contract as `PaymentProvider.verifyWebhookSignature`. */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean;

  parseWebhookPayload(rawBody: Buffer): ParsedDeliveryWebhookEvent;
}
