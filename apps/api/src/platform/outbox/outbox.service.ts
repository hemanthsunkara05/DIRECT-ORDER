import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import type { Logger } from 'pino';
import { PINO_LOGGER } from '../logging/logging.tokens.js';
import { OutboxRepository } from './outbox.repository.js';

const RELAY_INTERVAL_MS = 5_000;
const RELAY_BATCH_SIZE = 25;

export type OutboxConsumer = (event: OutboxEvent) => Promise<void>;

/**
 * The outbox pattern (docs/03-state-machines.md universal rule 4: side
 * effects "emitted as events after commit, never inside the
 * transaction"; docs/07-events-and-jobs.md). `record()` is called by a
 * state-changing service immediately after its own transaction commits
 * — a plain insert, not itself wrapped in that transaction, so a
 * relay failure can never roll back the state change it describes.
 *
 * The relay half is a lightweight in-process `setInterval` poller, not
 * a real BullMQ queue consumer — apps/worker's own Phase 1 doc comment
 * committed real consumers to "attach here starting Phase 12", and this
 * remains an honestly-scoped placeholder for that real queue, not a
 * finished one (see PHASE_REPORTS.md's Phase 12 entry for the specific
 * reasoning). What DID land in Phase 12: `registerConsumer()` below —
 * every relayed event is now handed to every registered consumer (e.g.
 * `NotificationDispatchService`) before being marked PROCESSED, so
 * "relaying" is no longer just a log line for the event types a
 * consumer actually cares about.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private readonly consumers: OutboxConsumer[] = [];

  constructor(
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  async record(eventType: string, payload: unknown, restaurantId?: string): Promise<void> {
    await this.outbox.create(eventType, payload, restaurantId);
  }

  /**
   * Runtime registration, not a DI-injected dependency — a domain
   * module (e.g. Phase 12's `NotificationsModule`) calls this from its
   * own `onModuleInit()` to be invoked for every relayed event. This is
   * the actual "Phase 12's real consumers attach here" this class has
   * promised since Phase 1 — deliberately a plain method call, not
   * `OutboxModule` importing a domain module, which would invert the
   * dependency direction docs/12-repository-structure.md requires
   * (platform never depends on a domain module, only the reverse). A
   * consumer that throws fails the WHOLE event (the same per-event
   * try/catch below already applies) — every registered consumer must
   * be as internally fault-tolerant as `NotificationDispatchService` is
   * documented to be.
   */
  registerConsumer(consumer: OutboxConsumer): void {
    this.consumers.push(consumer);
  }

  /** Phase 10's SSE replay/poll query — see OutboxRepository.findSinceForRestaurant. */
  async findSinceForRestaurant(restaurantId: string, afterId: string | undefined, limit = 50) {
    return this.outbox.findSinceForRestaurant(restaurantId, afterId, limit);
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
          'Outbox event relayed',
        );
        for (const consumer of this.consumers) {
          await consumer(event);
        }
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
