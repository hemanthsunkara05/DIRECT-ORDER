import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';
import type {
  NotificationChannelAdapter,
  SendNotificationInput,
  SendNotificationResult,
} from './notification-channel.port.js';

/**
 * `SMS_PROVIDER=console` (default) — logs the message instead of calling
 * MSG91, same reasoning as every other mock-first provider in this
 * codebase (`MockPaymentProvider`, `MockDeliveryProvider`): safe for
 * local dev and every automated test, no live network access needed or
 * assumed. Never throws — this is the always-available fallback.
 */
@Injectable()
export class ConsoleSmsProvider implements NotificationChannelAdapter {
  readonly name = 'console';

  constructor(@Inject(PINO_LOGGER) private readonly logger: Logger) {}

  send(input: SendNotificationInput): Promise<SendNotificationResult> {
    this.logger.info(
      { channel: 'SMS', to: input.to, title: input.title, body: input.body },
      '[console-sms] Notification (Phase 12 dev/test provider)',
    );
    return Promise.resolve({ providerMessageId: `console_sms_${randomUUID()}` });
  }
}
