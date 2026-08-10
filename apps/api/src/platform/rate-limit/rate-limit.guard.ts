import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { RateLimitedError } from '../errors/app-error.js';
import { PINO_LOGGER } from '../logging/logging.tokens.js';
import { RedisService } from '../redis/redis.service.js';
import { RATE_LIMIT_KEY, type RateLimitOptions } from './rate-limit.decorator.js';

/**
 * Reads `@RateLimit(...)` metadata (absent = no limit applied) and
 * enforces it against a Redis fixed-window counter, keyed by client IP
 * plus the route, so limits hold across every API instance rather than
 * resetting per-process (docs/09-security.md §15.7).
 *
 * Applied globally via APP_GUARD in identity.module.ts — routes without
 * `@RateLimit(...)` pass straight through with no Redis round trip.
 *
 * Fails OPEN, not closed: if Redis itself is unreachable, requests are
 * allowed through rather than rejected. Discovered by manually booting
 * the API against an unreachable Redis (Phase 3 report) — the guard's
 * first version let the Redis error propagate, which turned a Redis
 * outage into a total outage of every rate-limited endpoint (register,
 * login, password/forgot, otp/request), i.e. the whole authentication
 * surface. Rate limiting is defense-in-depth against brute force, not
 * the primary authentication control — losing it temporarily during a
 * Redis incident is an acceptable, logged degradation; losing the
 * entire ability to log in is not.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!options) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const key = this.buildKey(context, request, options);

    let count: number;
    try {
      count = await this.redis.client.incr(key);
      if (count === 1) {
        await this.redis.client.expire(key, options.windowSeconds);
      }
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), key },
        'Rate limit check failed (Redis unreachable) — allowing the request through',
      );
      return true;
    }

    if (count > options.limit) {
      const ttl = await this.redis.client.ttl(key);
      const retryAfterSeconds = ttl > 0 ? ttl : options.windowSeconds;

      const reply = context.switchToHttp().getResponse<FastifyReply>();
      reply.header('Retry-After', String(retryAfterSeconds));

      throw new RateLimitedError(
        `Too many requests. Please try again in ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
      );
    }

    return true;
  }

  private buildKey(
    context: ExecutionContext,
    request: FastifyRequest,
    options: RateLimitOptions,
  ): string {
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const extra = options.keyBy?.(request);
    return `ratelimit:${route}:${request.ip}${extra ? `:${extra}` : ''}`;
  }
}
