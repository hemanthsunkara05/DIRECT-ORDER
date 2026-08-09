import pino, { type Logger, type DestinationStream } from 'pino';
import { getCurrentRequestId } from './request-context.js';

/**
 * Field paths pino redacts from any log object, wherever they appear.
 * This is deliberately configured at the logger, not left to call-site
 * discipline (PRODUCT/docs/09-security.md §15.9 — "call-site discipline
 * fails eventually"). Extend this list before logging any new object
 * that might carry a sensitive field, never after an incident.
 */
const REDACT_PATHS = [
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.otp',
  '*.otpCode',
  '*.secret',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
  '*.cardNumber',
  '*.cvv',
  'req.headers.authorization',
  'req.headers.cookie',
];

/**
 * Creates the process-wide pino logger. Always emits structured JSON —
 * including in local development — so "every log line is JSON" holds
 * unconditionally (Phase 1 acceptance criteria), and so a developer's
 * local logs are representative of what production actually emits.
 *
 * The `mixin` runs on every log call and injects the current request's
 * correlation ID (if any) from AsyncLocalStorage, so call sites never
 * need to pass `requestId` explicitly.
 *
 * `destination` defaults to pino's normal stdout destination; tests
 * pass an in-memory stream so they can assert on this exact function's
 * output rather than a reconstruction of it.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const requestId = getCurrentRequestId();
      return requestId ? { requestId } : {};
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  return destination ? pino(options, destination) : pino(options);
}
