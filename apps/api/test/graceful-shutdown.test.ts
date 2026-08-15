import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { OutboxService } from '../src/platform/outbox/outbox.service.js';
import { OrderExpiryScheduler } from '../src/modules/orders/services/order-expiry.scheduler.js';
import { NotificationRetryScheduler } from '../src/modules/notifications/services/notification-retry.scheduler.js';
import { LoyaltyReconciliationService } from '../src/modules/loyalty/services/loyalty-reconciliation.service.js';
import { AnalyticsRollupService } from '../src/modules/analytics/services/analytics-rollup.service.js';
import { DataIntegrityService } from '../src/modules/data-integrity/services/data-integrity.service.js';

/**
 * Phase 19 — "graceful shutdown verification." Every self-starting
 * in-process poller in this codebase must clear its own timer on
 * `onModuleDestroy`, not just `.unref()` it — `.unref()` only stops
 * the timer from keeping the *process* alive; it does nothing to stop
 * a torn-down NestJS module (this test suite's own `app.close()`
 * between every test file, or a future hot-reload scenario) from
 * leaving a stale timer holding a reference to destroyed
 * dependencies. Found during Phase 19's own review that
 * `LoyaltyReconciliationService`/`AnalyticsRollupService` were the
 * only two of five schedulers NOT already doing this — fixed, and
 * this test is the regression guard for all five, not just the two
 * that were wrong.
 */
describe('Graceful shutdown (Phase 19): every self-starting scheduler clears its timer on destroy', () => {
  let ctx: TestApp;

  afterEach(async () => {
    // Some tests below already close ctx.app themselves; closing an
    // already-closed Nest app is a safe no-op.
    await ctx.app.close().catch(() => {});
  });

  const schedulers = [
    ['OutboxService', OutboxService],
    ['OrderExpiryScheduler', OrderExpiryScheduler],
    ['NotificationRetryScheduler', NotificationRetryScheduler],
    ['LoyaltyReconciliationService', LoyaltyReconciliationService],
    ['AnalyticsRollupService', AnalyticsRollupService],
    ['DataIntegrityService', DataIntegrityService],
  ] as const;

  it.each(schedulers)('%s clears its interval timer on onModuleDestroy', async (_name, ServiceClass) => {
    ctx = await createTestApp();
    const service = ctx.app.get(ServiceClass);
    // Each of these services stores its setInterval() return value on
    // a private `timer` field — accessed here the same way every
    // other test-only reach-into-private-state does in this suite.
    const timer = (service as unknown as { timer?: NodeJS.Timeout }).timer;
    expect(timer, `${ServiceClass.name} should have a timer set by onModuleInit`).toBeDefined();

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    (service as unknown as { onModuleDestroy: () => void }).onModuleDestroy();

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    clearIntervalSpy.mockRestore();
  });

  it('a real app.close() (SIGTERM-equivalent) resolves cleanly with every scheduler running, and does not hang', async () => {
    ctx = await createTestApp();
    // Touch every scheduler so its timer is definitely live before shutdown.
    for (const [, ServiceClass] of schedulers) {
      ctx.app.get(ServiceClass);
    }

    const closed = ctx.app.close();
    const timedOut = Promise.race([
      closed.then(() => 'closed' as const),
      new Promise((resolve) => setTimeout(() => resolve('timeout' as const), 5000)),
    ]);
    await expect(timedOut).resolves.toBe('closed');
  });
});
