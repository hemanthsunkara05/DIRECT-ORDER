import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { ProviderError } from '../../../platform/errors/app-error.js';
import type {
  NotificationChannelAdapter,
  SendNotificationInput,
  SendNotificationResult,
} from './notification-channel.port.js';

const GUPSHUP_API_URL = 'https://api.gupshup.io/wa/api/v1/msg';

/**
 * The real adapter — plain `fetch()` against Gupshup's documented
 * WhatsApp send-message API (`apikey` header, form-encoded body), not a
 * third-party SDK. Same rationale and same honesty standard as every
 * other real adapter in this codebase: correct against the documented
 * request shape, **genuinely unverified against the live API** without
 * real credentials and a WhatsApp Business API-approved sender number.
 */
@Injectable()
export class GupshupWhatsappProvider implements NotificationChannelAdapter {
  readonly name = 'gupshup';

  constructor(@Inject(APP_CONFIG) private readonly env: Env) {}

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    const apiKey = this.requireConfig('GUPSHUP_API_KEY');

    let res: Response;
    try {
      res = await fetch(GUPSHUP_API_URL, {
        method: 'POST',
        headers: {
          apikey: apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          channel: 'whatsapp',
          destination: input.to.replace('+', ''),
          message: JSON.stringify({ type: 'text', text: `${input.title}\n${input.body}` }),
        }).toString(),
      });
    } catch (error) {
      throw new ProviderError(
        `Gupshup request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        503,
      );
    }
    if (!res.ok) {
      throw new ProviderError(`Gupshup API returned ${res.status}`, 502);
    }
    const body = (await res.json()) as { messageId?: string };
    if (!body.messageId) {
      throw new ProviderError('Gupshup API did not return a messageId', 502);
    }
    return { providerMessageId: body.messageId };
  }

  private requireConfig(key: 'GUPSHUP_API_KEY'): string {
    const value = this.env[key];
    if (!value) {
      throw new ProviderError(
        `${key} is not configured — WHATSAPP_PROVIDER=gupshup requires real credentials.`,
        503,
      );
    }
    return value;
  }
}
