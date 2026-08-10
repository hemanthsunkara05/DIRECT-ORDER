import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
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

const UBER_AUTH_URL = 'https://auth.uber.com/oauth/v2/token';
const UBER_API_BASE = 'https://api.uber.com/v1';

/**
 * The real adapter — plain `fetch()` calls against Uber Direct's REST
 * API (OAuth2 client-credentials + a per-organization `customer_id`
 * path segment), not a third-party SDK. Same rationale as
 * `RazorpayPaymentProvider`: no live network path to Uber in this
 * sandbox, so a bespoke, auditable adapter costs less than an
 * unverifiable dependency. The request/response shapes and webhook
 * scheme below follow Uber Direct's published API — this is a correct
 * implementation, not a placeholder — but it is genuinely **unverified
 * against the live API** (RISK-3, docs/15-ambiguities-and-risks.md:
 * "Uber Direct self-serve access in Bengaluru unconfirmed... never
 * claim production delivery when mocked"). Report it as such, never as
 * "production ready."
 */
@Injectable()
export class UberDirectProvider implements DeliveryProvider {
  readonly name = 'uber_direct';

  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(@Inject(APP_CONFIG) private readonly env: Env) {}

  async createDelivery(input: CreateDeliveryInput): Promise<DeliveryQuote> {
    const res = await this.request('POST', '/deliveries', {
      external_id: input.orderNumber,
      idempotency_key: input.idempotencyKey,
      pickup_name: input.pickupBusinessName,
      pickup_address: formatAddress(input.pickupAddress),
      pickup_phone_number: '',
      dropoff_name: input.customerName,
      dropoff_address: formatAddress(input.dropoffAddress),
      dropoff_phone_number: input.customerPhone,
      manifest_reference: input.orderNumber,
    });
    const body = (await res.json()) as {
      id: string;
      status: string;
      tracking_url?: string;
      fee?: number;
      pickup_eta?: string;
      dropoff_eta?: string;
    };
    return {
      providerDeliveryId: body.id,
      status: mapUberStatus(body.status),
      trackingUrl: body.tracking_url,
      quotedFeeMinor: body.fee !== undefined ? BigInt(body.fee) : undefined,
      estimatedPickupAt: body.pickup_eta ? new Date(body.pickup_eta) : undefined,
      estimatedDeliveryAt: body.dropoff_eta ? new Date(body.dropoff_eta) : undefined,
    };
  }

  async fetchDeliveryStatus(providerDeliveryId: string): Promise<ProviderDeliveryStatus> {
    const res = await this.request('GET', `/deliveries/${providerDeliveryId}`);
    const body = (await res.json()) as {
      id: string;
      status: string;
      courier?: { name?: string; phone_number?: string };
      tracking_url?: string;
      fee?: number;
      dropoff_eta?: string;
    };
    return {
      providerDeliveryId: body.id,
      status: mapUberStatus(body.status),
      courierName: body.courier?.name,
      courierPhone: body.courier?.phone_number,
      trackingUrl: body.tracking_url,
      actualFeeMinor: body.fee !== undefined ? BigInt(body.fee) : undefined,
      deliveredAt:
        body.status === 'delivered' && body.dropoff_eta ? new Date(body.dropoff_eta) : undefined,
    };
  }

  async cancelDelivery(providerDeliveryId: string, reason: string): Promise<void> {
    await this.request('POST', `/deliveries/${providerDeliveryId}/cancel`, {
      cancellation_reason: reason,
    });
  }

  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    return verifyHmacSignature(
      rawBody,
      signatureHeader,
      this.requireConfig('UBER_DIRECT_WEBHOOK_SECRET'),
    );
  }

  parseWebhookPayload(rawBody: Buffer): ParsedDeliveryWebhookEvent {
    const parsed = JSON.parse(rawBody.toString('utf8')) as {
      id?: string;
      kind?: string;
      event_id?: string;
      status?: string;
      delivery_id?: string;
      data?: { id?: string; status?: string };
    };
    return {
      eventId: parsed.event_id ?? parsed.id ?? '',
      eventType: parsed.kind ?? parsed.status ?? parsed.data?.status ?? 'unknown',
      providerDeliveryId: parsed.delivery_id ?? parsed.data?.id,
      payload: parsed,
    };
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value;
    }
    const clientId = this.requireConfig('UBER_DIRECT_CLIENT_ID');
    const clientSecret = this.requireConfig('UBER_DIRECT_CLIENT_SECRET');

    let res: Response;
    try {
      res = await fetch(UBER_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
          scope: 'eats.deliveries',
        }).toString(),
      });
    } catch (error) {
      throw new ProviderError(
        `Uber Direct auth request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        503,
      );
    }
    if (!res.ok) {
      throw new ProviderError(`Uber Direct auth returned ${res.status}`, 502);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken = {
      value: body.access_token,
      // Refresh a minute early rather than racing the real expiry.
      expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    };
    return body.access_token;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const customerId = this.requireConfig('UBER_DIRECT_CUSTOMER_ID');
    const token = await this.getAccessToken();

    let res: Response;
    try {
      res = await fetch(`${UBER_API_BASE}/customers/${customerId}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      // Ambiguous — the request may have reached Uber before the
      // network failure. 503 signals "unknown, do not assume failure"
      // (docs/03-state-machines.md §7.4: "Timeout ≠ failure").
      throw new ProviderError(
        `Uber Direct request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        503,
      );
    }

    if (!res.ok) {
      // A definite HTTP-level rejection from Uber — not a timeout.
      throw new ProviderError(`Uber Direct API returned ${res.status} for ${method} ${path}`, 502);
    }
    return res;
  }

  private requireConfig(
    key:
      | 'UBER_DIRECT_CLIENT_ID'
      | 'UBER_DIRECT_CLIENT_SECRET'
      | 'UBER_DIRECT_WEBHOOK_SECRET'
      | 'UBER_DIRECT_CUSTOMER_ID',
  ): string {
    const value = this.env[key];
    if (!value) {
      throw new ProviderError(
        `${key} is not configured — DELIVERY_PROVIDER=uber_direct requires real credentials.`,
        503,
      );
    }
    return value;
  }
}

function formatAddress(address: CreateDeliveryInput['pickupAddress']): string {
  const parts = [address.line1, address.locality, address.city, address.postalCode].filter(Boolean);
  return parts.join(', ');
}

/**
 * Uber Direct's own delivery-status vocabulary (pending / pickup /
 * pickup_complete / dropoff / delivered / canceled / returned) does not
 * line up 1:1 with our internal `DeliveryStatus` — this mapping is a
 * good-faith best fit, unverified against the live API (see class doc
 * comment above).
 */
function mapUberStatus(status: string): ProviderDeliveryState {
  switch (status) {
    case 'pending':
      return 'SEARCHING_COURIER';
    case 'pickup':
      return 'COURIER_ASSIGNED';
    case 'pickup_complete':
      return 'PICKED_UP';
    case 'dropoff':
      return 'PICKED_UP';
    case 'delivered':
      return 'DELIVERED';
    case 'canceled':
      return 'CANCELLED';
    case 'returned':
      return 'FAILED';
    default:
      return 'CREATED';
  }
}
