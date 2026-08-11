import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';
import type {
  NotificationChannelAdapter,
  SendNotificationInput,
  SendNotificationResult,
} from './notification-channel.port.js';

/** `WHATSAPP_PROVIDER=console` (default) — see `ConsoleSmsProvider`'s own doc comment for the rationale, identical here. */
@Injectable()
export class ConsoleWhatsappProvider implements NotificationChannelAdapter {
  readonly name = 'console';

  constructor(@Inject(PINO_LOGGER) private readonly logger: Logger) {}

  send(input: SendNotificationInput): Promise<SendNotificationResult> {
    this.logger.info(
      { channel: 'WHATSAPP', to: input.to, title: input.title, body: input.body },
      '[console-whatsapp] Notification (Phase 12 dev/test provider)',
    );
    return Promise.resolve({ providerMessageId: `console_wa_${randomUUID()}` });
  }
}
