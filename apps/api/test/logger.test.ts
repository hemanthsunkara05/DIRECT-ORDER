import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/platform/logging/logger.js';
import { requestContextStorage } from '../src/platform/logging/request-context.js';

function captureLines(): { destination: Writable; lines: () => unknown[] } {
  const raw: string[] = [];
  const destination = new Writable({
    write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      raw.push(chunk.toString());
      callback();
    },
  });
  return { destination, lines: () => raw.map((line) => JSON.parse(line) as unknown) };
}

describe('createLogger — real production configuration', () => {
  it('emits a single valid JSON object per log call (Phase 1 acceptance: every log line is JSON)', () => {
    const { destination, lines } = captureLines();
    const logger = createLogger('debug', destination);

    logger.info({ event: 'order.accepted' }, 'Order accepted');

    const [parsed] = lines() as [Record<string, unknown>];
    expect(parsed.msg).toBe('Order accepted');
    expect(parsed.event).toBe('order.accepted');
    expect(parsed.level).toBe('info');
    expect(typeof parsed.time).toBe('string'); // ISO time, per stdTimeFunctions.isoTime
  });

  it('injects the correlation ID from AsyncLocalStorage without an explicit requestId at the call site', () => {
    const { destination, lines } = captureLines();
    const logger = createLogger('debug', destination);

    requestContextStorage.run({ requestId: 'req-abc-123' }, () => {
      logger.info('inside a request');
    });
    logger.info('outside any request');

    const [withinRequest, outsideRequest] = lines() as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(withinRequest.requestId).toBe('req-abc-123');
    expect(outsideRequest.requestId).toBeUndefined();
  });

  it('redacts passwords, tokens, and other configured sensitive fields (BR-152)', () => {
    const { destination, lines } = captureLines();
    const logger = createLogger('debug', destination);

    logger.info(
      {
        user: { password: 'hunter2', name: 'Asha' },
        auth: { token: 'ghp_secret', accessToken: 'abc', refreshToken: 'def', otp: '123456' },
      },
      'sensitive event',
    );

    const [parsed] = lines() as [
      {
        user: { password: string; name: string };
        auth: { token: string; accessToken: string; refreshToken: string; otp: string };
      },
    ];
    expect(parsed.user.password).toBe('[REDACTED]');
    expect(parsed.user.name).toBe('Asha');
    expect(parsed.auth.token).toBe('[REDACTED]');
    expect(parsed.auth.accessToken).toBe('[REDACTED]');
    expect(parsed.auth.refreshToken).toBe('[REDACTED]');
    expect(parsed.auth.otp).toBe('[REDACTED]');
  });

  it('masks a phone number to its last 4 digits, redacts email fully, and never partially reveals a token that happens to end in digits (Phase 18, docs/09-security.md §15.9)', () => {
    const { destination, lines } = captureLines();
    const logger = createLogger('debug', destination);

    logger.info(
      {
        customer: { phone: '+919876543210', customerPhone: '+919876500001', email: 'asha@example.com' },
        auth: { token: 'session-token-ending-in-1234' },
      },
      'sensitive event',
    );

    const [parsed] = lines() as [
      {
        customer: { phone: string; customerPhone: string; email: string };
        auth: { token: string };
      },
    ];
    expect(parsed.customer.phone).toBe('[REDACTED:...3210]');
    expect(parsed.customer.customerPhone).toBe('[REDACTED:...0001]');
    expect(parsed.customer.email).toBe('[REDACTED]');
    // A token ending in digits must be fully redacted, not last-4'd —
    // the censor dispatches on the matched field NAME, never the value.
    expect(parsed.auth.token).toBe('[REDACTED]');
  });

  it('respects the configured level — messages below it are not emitted', () => {
    const { destination, lines } = captureLines();
    const logger = createLogger('warn', destination);

    logger.debug('should not appear');
    logger.info('should not appear either');
    logger.warn('should appear');

    const [only] = lines() as [{ msg: string }];
    expect(lines()).toHaveLength(1);
    expect(only.msg).toBe('should appear');
  });
});
