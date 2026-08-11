import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { ProviderError } from '../../../platform/errors/app-error.js';
import type {
  NotificationChannelAdapter,
  SendNotificationInput,
  SendNotificationResult,
} from './notification-channel.port.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * The real adapter — plain `fetch()` against Resend's documented REST
 * API (`Authorization: Bearer <key>`), not the `resend` npm SDK. Same
 * rationale and honesty standard as every other real adapter here:
 * correct against the documented request shape, **genuinely unverified
 * against the live API** without real credentials.
 *
 * `body` is escaped into a minimal HTML wrapper — docs/08 §14.5:
 * "dynamic values are escaped... in every channel including email
 * HTML." The notification catalogue never interpolates untrusted input
 * (restaurant names, review text) into `title`/`body` without escaping
 * first — enforced in `notification-catalogue.ts`, not here; this
 * adapter's own escaping is a second, defense-in-depth layer against
 * whatever `body` it's actually handed.
 */
@Injectable()
export class ResendEmailProvider implements NotificationChannelAdapter {
  readonly name = 'resend';

  constructor(@Inject(APP_CONFIG) private readonly env: Env) {}

  async send(input: SendNotificationInput): Promise<SendNotificationResult> {
    const apiKey = this.requireConfig('RESEND_API_KEY');

    let res: Response;
    try {
      res = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.env.EMAIL_FROM,
          to: [input.to],
          subject: input.title,
          html: `<p>${escapeHtml(input.body)}</p>`,
        }),
      });
    } catch (error) {
      throw new ProviderError(
        `Resend request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        503,
      );
    }
    if (!res.ok) {
      throw new ProviderError(`Resend API returned ${res.status}`, 502);
    }
    const body = (await res.json()) as { id?: string };
    if (!body.id) {
      throw new ProviderError('Resend API did not return an id', 502);
    }
    return { providerMessageId: body.id };
  }

  private requireConfig(key: 'RESEND_API_KEY'): string {
    const value = this.env[key];
    if (!value) {
      throw new ProviderError(
        `${key} is not configured — EMAIL_PROVIDER=resend requires real credentials.`,
        503,
      );
    }
    return value;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
