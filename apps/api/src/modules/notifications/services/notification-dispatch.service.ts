import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { NotificationChannel, OutboxEvent } from '@prisma/client';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';
import { NotificationRepository } from '../repositories/notification.repository.js';
import { NotificationCatalogue, type NotificationDraft } from './notification-catalogue.js';
import { NotificationPreferenceService } from './notification-preference.service.js';
import {
  SMS_CHANNEL_ADAPTER,
  WHATSAPP_CHANNEL_ADAPTER,
  EMAIL_CHANNEL_ADAPTER,
  type NotificationChannelAdapter,
} from '../channels/notification-channel.port.js';

/** docs/07-events-and-jobs.md §12's default retry policy: "1s, 4s, 16s, 64s, 256s — max 5 attempts." */
export const MAX_NOTIFICATION_ATTEMPTS = 5;

function backoffMs(attempts: number): number {
  return 1000 * 4 ** (attempts - 1);
}

/**
 * The pipeline docs/08 §14.1 draws: `resolve recipients → apply
 * preferences → create Notification per (recipient, channel) →
 * [queue] → adapter → provider`. Called from `OutboxService`'s existing
 * relay tick (see that service's own extended doc comment) — strictly
 * after the triggering business transaction has already committed, so
 * a provider exception caught here can never roll back an order,
 * payment, or refund (BR-126). Every failure is caught locally; nothing
 * in this service ever throws out to its caller.
 *
 * IN_APP has no send step — creating the row already IS the delivery,
 * immediately marked SENT. External channels attempt a first send
 * synchronously; a failure schedules a backoff retry rather than
 * failing the whole event (see `NotificationRetryScheduler` for the
 * poller that actually revisits it, and this file's own doc comment on
 * why that's a lightweight poller and not real BullMQ this phase).
 */
@Injectable()
export class NotificationDispatchService implements OnModuleInit {
  constructor(
    @Inject(NotificationCatalogue) private readonly catalogue: NotificationCatalogue,
    @Inject(NotificationRepository) private readonly notifications: NotificationRepository,
    @Inject(NotificationPreferenceService)
    private readonly preferences: NotificationPreferenceService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(SMS_CHANNEL_ADAPTER) private readonly smsAdapter: NotificationChannelAdapter,
    @Inject(WHATSAPP_CHANNEL_ADAPTER) private readonly whatsappAdapter: NotificationChannelAdapter,
    @Inject(EMAIL_CHANNEL_ADAPTER) private readonly emailAdapter: NotificationChannelAdapter,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  /** Registers with `OutboxService`'s runtime consumer hook — see that method's own doc comment for why this is a plain method call, not a DI import, in either direction. */
  onModuleInit(): void {
    this.outbox.registerConsumer((event) => this.handleOutboxEvent(event));
  }

  async handleOutboxEvent(event: OutboxEvent): Promise<void> {
    const drafts = await this.catalogue.resolve(event.eventType, event.payload);
    for (const draft of drafts) {
      for (const channel of draft.channels) {
        await this.dispatchOne(event.id, draft, channel);
      }
    }
  }

  private async dispatchOne(
    outboxEventId: string,
    draft: NotificationDraft,
    channel: NotificationChannel,
  ): Promise<void> {
    // The dedup guarantee (docs/14.1) — always attempt the insert, let
    // `@@unique([outboxEventId, recipientType, recipientId, channel])`
    // decide. A duplicate outbox relay tick (or a duplicate event) hits
    // this constraint and returns null: nothing further happens.
    const contactAddress =
      channel === 'EMAIL' ? draft.email : channel === 'IN_APP' ? null : draft.phone;
    const created = await this.notifications.createIfNotExists({
      outboxEventId,
      type: draft.type,
      category: draft.category,
      recipientType: draft.recipientType,
      recipientId: draft.recipientId,
      channel,
      title: draft.title,
      body: draft.body,
      contactAddress,
    });
    if (!created) return;

    if (draft.category === 'MARKETING') {
      const consented = await this.preferences.hasMarketingConsent(
        draft.recipientType,
        draft.recipientId,
      );
      if (!consented) {
        await this.notifications.update(created.id, {
          status: 'SUPPRESSED',
          lastError: 'No recorded marketing consent (BR-129).',
        });
        return;
      }
    }

    const enabled = await this.preferences.isEnabled(
      draft.recipientType,
      draft.recipientId,
      draft.category,
      channel,
    );
    if (!enabled) {
      await this.notifications.update(created.id, {
        status: 'SUPPRESSED',
        lastError: 'Disabled by recipient preference.',
      });
      return;
    }

    if (channel === 'IN_APP') {
      await this.notifications.update(created.id, { status: 'SENT', sentAt: new Date() });
      return;
    }

    if (!created.contactAddress) {
      await this.notifications.update(created.id, {
        status: 'SUPPRESSED',
        lastError: `No ${channel === 'EMAIL' ? 'email address' : 'phone number'} on file for this recipient.`,
      });
      return;
    }

    await this.attemptSend(created.id);
  }

  /**
   * Shared by first-attempt dispatch above and `NotificationRetryScheduler`'s
   * later retries — one send-and-record-outcome path, not two. Reads
   * `title`/`body`/`contactAddress` off the `Notification` row itself
   * rather than taking them as parameters, so a retry (which only ever
   * has the notification's id) needs nothing else to replay the exact
   * same send.
   */
  async attemptSend(notificationId: string): Promise<void> {
    const notification = await this.notifications.findById(notificationId);
    if (!notification || !notification.contactAddress) return; // defensive — IN_APP/suppressed rows never reach here
    const channel = notification.channel;

    try {
      const result = await this.adapterFor(channel).send({
        to: notification.contactAddress,
        title: notification.title,
        body: notification.body,
      });
      await this.notifications.update(notificationId, {
        status: 'SENT',
        providerMessageId: result.providerMessageId,
        sentAt: new Date(),
        lastError: null,
        nextAttemptAt: null,
      });
    } catch (error) {
      const attempts = notification.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);

      if (attempts >= MAX_NOTIFICATION_ATTEMPTS) {
        await this.notifications.update(notificationId, {
          status: 'DEAD_LETTERED',
          attempts: { increment: 1 },
          lastError: message,
          nextAttemptAt: null,
        });
        this.logger.error(
          { notificationId, channel, attempts, err: error },
          'Notification dead-lettered after exhausting retries',
        );
      } else {
        await this.notifications.update(notificationId, {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: message,
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        });
        this.logger.warn(
          { notificationId, channel, attempts, err: error },
          'Notification send failed — will retry with backoff',
        );
      }
    }
  }

  private adapterFor(channel: NotificationChannel): NotificationChannelAdapter {
    switch (channel) {
      case 'SMS':
        return this.smsAdapter;
      case 'WHATSAPP':
        return this.whatsappAdapter;
      case 'EMAIL':
        return this.emailAdapter;
      default:
        throw new Error(`No external adapter for channel ${channel}`);
    }
  }
}
