import { Inject, Injectable, type MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';

const POLL_INTERVAL_MS = 3_000;
const REPLAY_BATCH_SIZE = 50;

/**
 * `GET /restaurant/orders/stream` (docs/04-api-specification.md §8.5):
 * "SSE is a latency optimisation, never the source of truth. On
 * connect or reconnect the client sends `Last-Event-ID`; the server
 * replays missed events from the database... A restaurant must never
 * miss a paid order because a connection dropped." This is a plain
 * DB-poll Observable, the same "lightweight in-process poller" shape
 * as OutboxService's own relay and OrderExpiryScheduler — not a real
 * pub/sub. That's a deliberate, honestly-scoped choice, not a
 * shortcut: the actual guarantee the acceptance criteria need
 * ("dashboard closed during payment then reconnects and sees the
 * order") comes from the database being authoritative and the order
 * queue (`GET /restaurant/orders`) always reflecting current state —
 * this stream only shaves the latency off *discovering* that a new
 * event exists, and the frontend's 15s polling fallback (docs/04
 * §8.5) covers the case where this stream is unavailable at all.
 */
@Injectable()
export class OrderStreamService {
  constructor(@Inject(OutboxService) private readonly outbox: OutboxService) {}

  stream(restaurantId: string, lastEventId: string | undefined): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let cursor = lastEventId;
      let inFlight = false;

      const poll = (): void => {
        if (inFlight) return; // never overlap two polls if one is slow
        inFlight = true;
        this.outbox
          .findSinceForRestaurant(restaurantId, cursor, REPLAY_BATCH_SIZE)
          .then((events) => {
            for (const event of events) {
              subscriber.next({
                id: event.id,
                type: event.eventType,
                data: event.payload as object,
              });
              cursor = event.id;
            }
          })
          .catch(() => {
            // A transient DB error drops this tick, not the connection —
            // the next poll retries; the client's own reconnect-with-
            // Last-Event-ID handles a genuinely dead connection.
          })
          .finally(() => {
            inFlight = false;
          });
      };

      poll(); // immediate catch-up on connect, before the first interval tick
      const timer = setInterval(poll, POLL_INTERVAL_MS);

      return () => clearInterval(timer);
    });
  }
}
