import * as Sentry from '@sentry/node';
import type { WorkerEnv } from './env.schema.js';

/** Phase 19. Same conditional-init shape as apps/api's sentry.ts — a genuine no-op without a real `SENTRY_DSN`. */
export function initSentry(env: Pick<WorkerEnv, 'SENTRY_DSN' | 'SENTRY_ENVIRONMENT' | 'APP_ENV'>): void {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.APP_ENV,
  });
}

export function captureException(error: unknown): void {
  Sentry.captureException(error);
}
