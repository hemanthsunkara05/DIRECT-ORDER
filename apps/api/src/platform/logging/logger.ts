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
  // docs/09-security.md §15.9: "full phone numbers (log last 4 digits),
  // email addresses in bulk." Matched by field-name suffix via the
  // custom censor below (redactCensor), not by full-object removal —
  // `*.phone` alone would miss `customerPhone`/`guestPhone`/etc., and
  // fast-redact's wildcard is a single level, not a recursive-descend
  // pattern, so every actually-logged field name is listed explicitly
  // rather than assumed to be named exactly "phone"/"email".
  '*.phone',
  '*.customerPhone',
  '*.guestPhone',
  '*.email',
  '*.customerEmail',
];

const PHONE_FIELD_NAMES = new Set(['phone', 'customerphone', 'guestphone']);

/**
 * A phone number is masked to its last 4 digits (still useful for
 * support correlation, per docs/09 §15.9's own carve-out) rather than
 * fully redacted like a password/token; every other matched path
 * (including email) is censored outright. Dispatches on `path` — the
 * matched field NAME — never on the value's own shape: a password or
 * token that happens to end in 4 digits must never fall through to the
 * partial-reveal branch just because it "looks like" a phone number.
 * `fast-redact` (pino's redact engine) supports a censor FUNCTION with
 * this exact `(value, path)` signature for precisely this distinction.
 */
function redactCensor(value: unknown, path: string[]): unknown {
  const fieldName = (path.at(-1) ?? '').toLowerCase();
  if (PHONE_FIELD_NAMES.has(fieldName) && typeof value === 'string' && value.length > 4) {
    return `[REDACTED:...${value.slice(-4)}]`;
  }
  return '[REDACTED]';
}

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
    redact: { paths: REDACT_PATHS, censor: redactCensor },
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
