import { describe, expect, it } from 'vitest';
import { initSentry, captureException } from '../src/platform/observability/sentry.js';

/**
 * Phase 19. Every local/test environment in this sandbox has no real
 * `SENTRY_DSN` — these assert that's a genuine no-op, never a thrown
 * error, at both call sites `main.ts`/`GlobalExceptionFilter` use.
 */
describe('Sentry wiring (Phase 19)', () => {
  it('initSentry is a no-op without SENTRY_DSN', () => {
    expect(() => initSentry({ SENTRY_DSN: undefined, SENTRY_ENVIRONMENT: undefined, APP_ENV: 'test' })).not.toThrow();
  });

  it('captureException never throws, even when Sentry was never initialized', () => {
    expect(() => captureException(new Error('unhandled test error'))).not.toThrow();
    expect(() => captureException('a non-Error thrown value')).not.toThrow();
  });
});
