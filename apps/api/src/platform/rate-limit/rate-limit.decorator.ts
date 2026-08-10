import { SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  /**
   * An additional key component beyond the client IP — e.g. the email
   * from a login/register body, so a rate limit can also be scoped "per
   * identifier" (docs/04-api-specification.md §8.2: OTP request is rate
   * limited "per phone and IP"). Returning undefined limits by IP alone.
   */
  keyBy?: (req: FastifyRequest) => string | undefined;
}

/**
 * Applies a Redis-backed, fixed-window rate limit to a single route
 * handler. Fixed-window (INCR + EXPIRE) rather than a sliding-window
 * algorithm — simpler to reason about and test, and the accuracy
 * difference at the boundary between windows does not matter for the
 * threat this defends against (credential-stuffing / brute-force
 * volume, not precise quota billing). See RateLimitGuard.
 */
export function RateLimit(options: RateLimitOptions): MethodDecorator {
  return SetMetadata(RATE_LIMIT_KEY, options);
}
