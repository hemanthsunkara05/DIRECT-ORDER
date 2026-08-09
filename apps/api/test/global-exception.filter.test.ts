import { NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { z, type ZodError } from 'zod';
import { ErrorEnvelopeSchema } from '@direct-order/contracts';
import { requestContextStorage } from '../src/platform/logging/request-context.js';
import { GlobalExceptionFilter } from '../src/platform/errors/global-exception.filter.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../src/platform/errors/app-error.js';

function createHost() {
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);

  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;

  return { host, reply };
}

/** A minimal pino stand-in: only the methods GlobalExceptionFilter actually calls. */
function createFakeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
}

describe('GlobalExceptionFilter', () => {
  it('maps AppError subclasses to their declared status/code, inside the request envelope', () => {
    const logger = createFakeLogger();
    const filter = new GlobalExceptionFilter(logger);
    const { host, reply } = createHost();

    requestContextStorage.run({ requestId: 'req-123' }, () => {
      filter.catch(new NotFoundError('Restaurant not found.'), host);
    });

    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      error: { code: 'NOT_FOUND', message: 'Restaurant not found.', requestId: 'req-123' },
    });
  });

  it('maps ConflictError to 409 with details preserved', () => {
    const logger = createFakeLogger();
    const filter = new GlobalExceptionFilter(logger);
    const { host, reply } = createHost();

    requestContextStorage.run({ requestId: 'req-456' }, () => {
      filter.catch(
        new ConflictError('Order already accepted.', [{ field: 'status', message: 'ACCEPTED' }]),
        host,
      );
    });

    const body = reply.send.mock.calls[0]![0];
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.details).toEqual([{ field: 'status', message: 'ACCEPTED' }]);
  });

  it('maps ForbiddenError and ValidationError correctly', () => {
    const logger = createFakeLogger();
    const filter = new GlobalExceptionFilter(logger);

    const { host: h1, reply: r1 } = createHost();
    requestContextStorage.run({ requestId: 'r1' }, () => filter.catch(new ForbiddenError(), h1));
    expect(r1.code).toHaveBeenCalledWith(403);

    const { host: h2, reply: r2 } = createHost();
    requestContextStorage.run({ requestId: 'r2' }, () =>
      filter.catch(new ValidationError('Bad input.'), h2),
    );
    expect(r2.code).toHaveBeenCalledWith(422);
  });

  it('maps a ZodError to 422 VALIDATION_ERROR with field-level details', () => {
    const logger = createFakeLogger();
    const filter = new GlobalExceptionFilter(logger);
    const { host, reply } = createHost();

    const schema = z.object({ email: z.string().email() });
    const result = schema.safeParse({ email: 'not-an-email' });
    expect(result.success).toBe(false);

    requestContextStorage.run({ requestId: 'req-zod' }, () => {
      filter.catch((result as { success: false; error: ZodError }).error, host);
    });

    const body = reply.send.mock.calls[0]![0];
    expect(reply.code).toHaveBeenCalledWith(422);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details[0].field).toBe('email');
  });

  it('maps a NestJS HttpException using the status-to-code table', () => {
    const logger = createFakeLogger();
    const filter = new GlobalExceptionFilter(logger);
    const { host, reply } = createHost();

    requestContextStorage.run({ requestId: 'req-http' }, () => {
      filter.catch(new NotFoundException('No route matches GET /nope'), host);
    });

    expect(reply.code).toHaveBeenCalledWith(404);
    const body = reply.send.mock.calls[0]![0];
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('maps a completely unexpected error to an opaque 500 without leaking internal details', () => {
    const logger = createFakeLogger();
    const filter = new GlobalExceptionFilter(logger);
    const { host, reply } = createHost();

    const internalError = new Error('connection to 10.0.4.12:5432 refused, password="hunter2"');

    requestContextStorage.run({ requestId: 'req-500' }, () => {
      filter.catch(internalError, host);
    });

    expect(reply.code).toHaveBeenCalledWith(500);
    const body = reply.send.mock.calls[0]![0];
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).not.toContain('10.0.4.12');
    expect(body.error.message).not.toContain('hunter2');
    expect(body.error.message).not.toContain('password');

    // But it MUST have been logged internally with the full detail, so
    // an operator can actually investigate using the requestId.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-500',
        err: expect.objectContaining({ message: expect.stringContaining('hunter2') }),
      }),
      expect.any(String),
    );
  });

  it('every produced envelope validates against the shared ErrorEnvelopeSchema', () => {
    const logger = createFakeLogger();
    const filter = new GlobalExceptionFilter(logger);
    const { host, reply } = createHost();

    requestContextStorage.run({ requestId: 'req-schema' }, () => {
      filter.catch(new ValidationError('Bad input.', [{ field: 'x', message: 'required' }]), host);
    });

    const body = reply.send.mock.calls[0]![0];
    expect(() => ErrorEnvelopeSchema.parse(body)).not.toThrow();
  });

  it('falls back to requestId "unknown" if called outside a request context (defensive, should not happen in production)', () => {
    const logger = createFakeLogger();
    const filter = new GlobalExceptionFilter(logger);
    const { host, reply } = createHost();

    filter.catch(new NotFoundError(), host);

    const body = reply.send.mock.calls[0]![0];
    expect(body.error.requestId).toBe('unknown');
  });
});
