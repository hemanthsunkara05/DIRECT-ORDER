import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ErrorEnvelopeSchema,
  HealthResponseSchema,
  ReadyResponseSchema,
  successEnvelope,
} from '../src/index.js';

describe('ErrorEnvelopeSchema', () => {
  it('accepts a well-formed error envelope', () => {
    const result = ErrorEnvelopeSchema.safeParse({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        requestId: '01J0000000000000000000000',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an envelope missing requestId', () => {
    const result = ErrorEnvelopeSchema.safeParse({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request.' },
    });
    expect(result.success).toBe(false);
  });
});

describe('successEnvelope', () => {
  it('validates data against the provided schema', () => {
    const schema = successEnvelope(z.object({ id: z.string() }));
    const result = schema.safeParse({
      data: { id: 'abc' },
      meta: { requestId: 'req-1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects data that does not match the provided schema', () => {
    const schema = successEnvelope(z.object({ id: z.string() }));
    const result = schema.safeParse({
      data: { id: 123 },
      meta: { requestId: 'req-1' },
    });
    expect(result.success).toBe(false);
  });
});

describe('HealthResponseSchema', () => {
  it('accepts { status: "ok" }', () => {
    expect(HealthResponseSchema.safeParse({ status: 'ok' }).success).toBe(true);
  });
});

describe('ReadyResponseSchema', () => {
  it('accepts a ready response with a database check', () => {
    const result = ReadyResponseSchema.safeParse({
      status: 'ready',
      checks: { database: { status: 'ok', latencyMs: 3 } },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a not_ready response with an error detail', () => {
    const result = ReadyResponseSchema.safeParse({
      status: 'not_ready',
      checks: { database: { status: 'error', error: 'connection refused' } },
    });
    expect(result.success).toBe(true);
  });
});
