import type { ErrorDetail } from '@direct-order/contracts';

/**
 * The base of every intentional, typed error the application throws.
 * A handler never throws a bare `Error` on a path a user can reach
 * (PRODUCT/docs/12-repository-structure.md §19.4) — it throws one of
 * these, and the global exception filter maps it to the standard error
 * envelope. `code` is stable and client-branchable; `message` is safe
 * for direct display; `details` is structured, never a stack trace.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The request could not be validated.', details?: ErrorDetail[]) {
    super('VALIDATION_ERROR', 422, message, details);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication is required.') {
    super('UNAUTHENTICATED', 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super('FORBIDDEN', 403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super('NOT_FOUND', 404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: ErrorDetail[]) {
    super('CONFLICT', 409, message, details);
  }
}

export class RateLimitedError extends AppError {
  constructor(
    message = 'Too many requests. Please try again shortly.',
    public readonly retryAfterSeconds?: number,
  ) {
    super('RATE_LIMITED', 429, message);
  }
}

/** An external provider (payment, delivery, notification, storage) failed or timed out. */
export class ProviderError extends AppError {
  constructor(message: string, httpStatus: 502 | 503 = 502) {
    super('SERVICE_UNAVAILABLE', httpStatus, message);
  }
}
