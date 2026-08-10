import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Logger } from 'pino';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { PINO_LOGGER } from '../../../platform/logging/logging.tokens.js';
import { OrderRepository } from '../repositories/order.repository.js';
import { OrderStateService } from './order-state.service.js';

const SCAN_INTERVAL_MS = 60_000;
const MINUTE_MS = 60_000;

/**
 * docs/03-state-machines.md §7.1: `PENDING_PAYMENT → EXPIRED`, "Older
 * than ORDER_PAYMENT_TTL_MINUTES (default 30), no capture." A plain
 * in-process `setInterval` poller, same honestly-scoped shape as
 * `OutboxService`'s relay — real Postgres could instead use `pg_cron`
 * or a proper worker-queue job (Phase 12), but this sandbox has neither
 * Docker/Postgres nor a real queue to verify either against.
 *
 * Each expiry goes through `OrderStateService.transition`, not a direct
 * status write — so it gets the same locking, history-append, and
 * illegal-transition protection as every other transition (an order
 * that was verified-paid a moment before this tick runs simply fails
 * the PENDING_PAYMENT precondition and is skipped, never double-moved).
 */
@Injectable()
export class OrderExpiryScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(OrderStateService) private readonly orderState: OrderStateService,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => {
        this.logger.error({ err: error }, 'Order expiry scan failed');
      });
    }, SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    const cutoff = new Date(Date.now() - this.env.ORDER_PAYMENT_TTL_MINUTES * MINUTE_MS);
    const stale = await this.orders.findPendingPaymentOlderThan(cutoff);

    let expired = 0;
    for (const order of stale) {
      try {
        const result = await this.orderState.transition(order.id, 'EXPIRED', { type: 'SYSTEM' });
        if (result.applied) expired++;
      } catch (error) {
        this.logger.warn(
          { err: error, orderId: order.id },
          'Failed to expire a stale PENDING_PAYMENT order — will retry next scan',
        );
      }
    }
    return expired;
  }
}
