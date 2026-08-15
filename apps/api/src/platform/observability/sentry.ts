import * as Sentry from '@sentry/node';
import type { Env } from '../config/env.schema.js';

/**
 * Phase 19. A genuine no-op when `SENTRY_DSN` isn't set — every local
 * dev environment and every automated test run in this sandbox has no
 * real DSN, so this never activates there, matching the "real
 * integration wired ahead of real credentials" treatment
 * `PAYMENT_PROVIDER`/`DELIVERY_PROVIDER` already established.
 * `GlobalExceptionFilter` calls `captureException` for every 5xx it
 * maps — see that file — so an unwired Sentry never sees application
 * errors, only whatever this init call itself might report.
 */
export function initSentry(env: Pick<Env, 'SENTRY_DSN' | 'SENTRY_ENVIRONMENT' | 'APP_ENV'>): void {
  if (!env.SENTRY_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.APP_ENV,
  });
}

/** `GlobalExceptionFilter`'s single call site — isolated here so the filter itself doesn't need to know whether Sentry is actually active. */
export function captureException(error: unknown): void {
  Sentry.captureException(error);
}
