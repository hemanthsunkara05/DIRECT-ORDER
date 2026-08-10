import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../logging/logging.tokens.js';
import { OutboxRepository } from './outbox.repository.js';

const RELAY_INTERVAL_MS = 5_000;
const RELAY_BATCH_SIZE = 25;

/**
 * The outbox pattern (docs/03-state-machines.md universal rule 4: side
 * effects "emitted as events after commit, never inside the
 * transaction"; docs/07-events-and-jobs.md). `record()` is called by a
 * state-changing service immediately after its own transaction commits
 * — a plain insert, not itself wrapped in that transaction, so a
 * relay failure can never roll back the state change it describes.
 *
 * The relay half is a lightweight in-process `setInterval` poller, not
 * a real queue consumer — apps/worker's own Phase 1 doc comment already
 * commits real job consumers to "attach here starting Phase 12", and
 * this sandbox has no Docker/Redis-backed queue to verify one against
 * anyway (standing limitation, every prior phase report). "Relaying" an
 * event today means logging it as delivered and marking it PROCESSED —
 * there is no notification pipeline yet for it to actually reach
 * (Phase 12+ per docs/08-search-and-notifications.md). This is an
 * honestly-scoped placeholder for a real relay, not a finished one:
 * report it as such.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  async record(eventType: string, payload: unknown): Promise<void> {
    await this.outbox.create(eventType, payload);
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.relayPending().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Outbox relay tick failed');
      });
    }, RELAY_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async relayPending(): Promise<number> {
    const pending = await this.outbox.findPending(RELAY_BATCH_SIZE);
    for (const event of pending) {
      try {
        this.logger.info(
          { eventId: event.id, eventType: event.eventType, payload: event.payload },
          'Outbox event relayed (log-only relay — no queue/notification pipeline until Phase 12)',
        );
        await this.outbox.markProcessed(event.id);
      } catch (error) {
        await this.outbox.markFailed(
          event.id,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return pending.length;
  }
}
