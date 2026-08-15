import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { ZodError } from 'zod';
import type { ErrorDetail, ErrorEnvelope } from '@direct-order/contracts';
import { getCurrentRequestId } from '../logging/request-context.js';
import { PINO_LOGGER } from '../logging/logging.tokens.js';
import { AppError } from './app-error.js';

const STATUS_TO_CODE: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'VALIDATION_ERROR',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Fastify's own errors (body-too-large, malformed content-type, etc. —
 * thrown by Fastify itself or a registered plugin, before Nest's
 * routing layer ever sees the request) are plain objects carrying a
 * `statusCode`, not instances of Nest's `HttpException` — found via
 * Phase 18's body-limit regression test, which surfaced a raw 1MB
 * body-too-large request as an opaque 500 INTERNAL_ERROR instead of
 * 413, the same class of gap Phase 9's `ProviderError` fix (see
 * checkout.e2e.test.ts) already caught for an unrecognized payment
 * provider error shape.
 */
function isFastifyStatusError(error: unknown): error is { statusCode: number; message?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
  );
}

interface MappedError {
  status: number;
  code: string;
  message: string;
  details?: ErrorDetail[];
  /** The original error, kept only for internal logging — never serialised to the client. */
  cause: unknown;
}

/**
 * The single point where every error thrown anywhere in the request
 * lifecycle becomes an HTTP response. Maps to the standard envelope
 * (PRODUCT/docs/04-api-specification.md §8.1):
 *
 *   { "error": { "code", "message", "details", "requestId" } }
 *
 * Production responses never contain stack traces, SQL, or file paths
 * (BR-156) — those go to the internal log line, keyed by the same
 * requestId a client can report back to support.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(@Inject(PINO_LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const requestId = getCurrentRequestId() ?? 'unknown';

    const mapped = this.mapException(exception);
    this.log(mapped, requestId);

    const body: ErrorEnvelope = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details ? { details: mapped.details } : {}),
        requestId,
      },
    };

    reply.code(mapped.status).send(body);
  }

  private mapException(exception: unknown): MappedError {
    if (exception instanceof AppError) {
      return {
        status: exception.httpStatus,
        code: exception.code,
        message: exception.message,
        details: exception.details,
        cause: exception,
      };
    }

    if (exception instanceof ZodError) {
      const details: ErrorDetail[] = exception.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      return {
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'The request could not be validated.',
        details,
        cause: exception,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : (this.extractMessage(response) ?? exception.message);

      return {
        status,
        code: STATUS_TO_CODE[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR'),
        message,
        cause: exception,
      };
    }

    if (isFastifyStatusError(exception) && exception.statusCode < 500) {
      const status = exception.statusCode;
      return {
        status,
        code: STATUS_TO_CODE[status] ?? 'HTTP_ERROR',
        message: exception.message ?? 'The request could not be processed.',
        cause: exception,
      };
    }

    // Truly unexpected — never expose internals to the client.
    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Please try again or contact support.',
      cause: exception,
    };
  }

  private extractMessage(response: object): string | undefined {
    if ('message' in response) {
      const value = response.message;
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.join(' ');
    }
    return undefined;
  }

  private log(mapped: MappedError, requestId: string): void {
    const context = { requestId, code: mapped.code, status: mapped.status };

    if (mapped.status >= 500) {
      this.logger.error(
        { ...context, err: this.serializeError(mapped.cause) },
        'Unhandled error while processing request',
      );
      return;
    }

    if (mapped.status >= 400) {
      this.logger.warn(context, 'Request rejected');
    }
  }

  private serializeError(error: unknown): { message: string; stack?: string; name?: string } {
    if (error instanceof Error) {
      return { message: error.message, stack: error.stack, name: error.name };
    }
    return { message: String(error) };
  }
}
