import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { ProviderError } from '../../../platform/errors/app-error.js';
import type {
  NotificationChannelAdapter,
  SendNotificationInput,
  SendNotificationResult,
} from './notification-channel.port.js';

const MSG91_API_BASE = 'https://control.msg91.com/api/v5';

/**
 * The real adapter — plain `fetch()` against MSG91's documented Send SMS
 * API (`authkey` header, sender id, mobile number, message body), not
 * the `msg91` npm SDK. Same rationale as `RazorpayPaymentProvider`: no
 * live network path to MSG91 in this sandbox, so a small, auditable
 * adapter costs less than an unverifiable dependency. Correct against
 * the documented request shape, but **genuinely unverified against the
 * live API** — report it as such, never as "production ready."
 *
 * docs/08-search-and-notifications.md §14.2: "MSG91 (DLT templates
 * required)" — India's DLT (Distributed Ledger Technology) regulation
 * requires every transactional/promotional SMS template to be
 * pre-registered and approved before it can send; this adapter sends
 * the notification's already-composed `body` as-is, which only works
 * once a real DLT-approved template matching that exact text exists on
 * the MSG91 account — a real operational prerequisite this code cannot
 * satisfy on its own, flagged here rather than silently assumed away.
 */
@Injectable()
export class Msg91SmsProvider implements NotificationChannelAdapter {
  readonly name = 'msg91';

  constructor(@Inject(APP_CONFIG) private readonly env: Env) {}

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    const authKey = this.requireConfig('MSG91_AUTH_KEY');
    const senderId = this.requireConfig('MSG91_SENDER_ID');

    let res: Response;
    try {
      res = await fetch(`${MSG91_API_BASE}/flow/`, {
        method: 'POST',
        headers: { authkey: authKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: senderId,
          mobiles: input.to.replace('+', ''),
          message: input.body,
        }),
      });
    } catch (error) {
      throw new ProviderError(
        `MSG91 request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        503,
      );
    }
    if (!res.ok) {
      throw new ProviderError(`MSG91 API returned ${res.status}`, 502);
    }
    const body = (await res.json()) as { request_id?: string; message?: string };
    if (!body.request_id) {
      throw new ProviderError(
        `MSG91 API did not return a request_id: ${body.message ?? 'unknown'}`,
        502,
      );
    }
    return { providerMessageId: body.request_id };
  }

  private requireConfig(key: 'MSG91_AUTH_KEY' | 'MSG91_SENDER_ID'): string {
    const value = this.env[key];
    if (!value) {
      throw new ProviderError(
        `${key} is not configured — SMS_PROVIDER=msg91 requires real credentials.`,
        503,
      );
    }
    return value;
  }
}
