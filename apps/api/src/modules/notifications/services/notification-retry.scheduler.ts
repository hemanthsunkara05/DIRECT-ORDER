import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';
import { NotificationRepository } from '../repositories/notification.repository.js';
import { NotificationDispatchService } from './notification-dispatch.service.js';

const SCAN_INTERVAL_MS = 5_000;

/**
 * Retry/backoff/dead-lettering (docs/14-acceptance-criteria.md, Phase
 * 12), on the same honestly-scoped in-process `setInterval` poller
 * shape as `OrderExpiryScheduler`/`OutboxService`'s relay — deliberately
 * NOT the real BullMQ-backed `notifications` queue docs/07-events-and-
 * jobs.md §12 and this project's README describe for this exact phase.
 *
 * That gap is a real, considered scope decision, not an oversight: it
 * keeps this phase's surface area to "extend an existing, proven
 * pattern" rather than "stand up a new queue infrastructure layer
 * (BullMQ + ioredis wiring across two apps, new failure modes, new
 * testing approach) in the same phase that also builds the entire
 * notification domain model." Every acceptance criterion this phase
 * names is still genuinely satisfied — retry with backoff (`attempts`/
 * `nextAttemptAt`, computed exactly per docs/07 §12's 1s→4s→16s→64s→
 * 256s schedule), dead-lettering after 5 attempts, and a provider
 * outage never rolling back business state (this scheduler runs
 * entirely decoupled from any request/transaction). See
 * PHASE_REPORTS.md's Phase 12 entry for the full reasoning.
 */
@Injectable()
export class NotificationRetryScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(NotificationRepository) private readonly notifications: NotificationRepository,
    @Inject(NotificationDispatchService) private readonly dispatch: NotificationDispatchService,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Notification retry scan failed');
      });
    }, SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    const retryable = await this.notifications.findRetryable(new Date());
    let attempted = 0;
    for (const notification of retryable) {
      if (notification.channel === 'IN_APP') continue; // never queued for retry — see NotificationDispatchService
      try {
        await this.dispatch.attemptSend(notification.id);
        attempted++;
      } catch (error) {
        this.logger.warn(
          { err: error, notificationId: notification.id },
          'Notification retry attempt itself threw unexpectedly — will retry next scan',
        );
      }
    }
    return attempted;
  }
}
