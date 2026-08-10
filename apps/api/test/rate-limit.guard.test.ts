import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { RateLimitGuard } from '../src/platform/rate-limit/rate-limit.guard.js';
import type { RateLimitOptions } from '../src/platform/rate-limit/rate-limit.decorator.js';
import { RateLimitedError } from '../src/platform/errors/app-error.js';
import type { RedisService } from '../src/platform/redis/redis.service.js';

function createContext(
  request: { ip: string; body?: unknown } = { ip: '127.0.0.1' },
): ExecutionContext {
  const reply = { header: vi.fn() };
  return {
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
}

function createReflector(options: RateLimitOptions | undefined): Reflector {
  return { get: () => options } as unknown as Reflector;
}

function createLogger(): Logger {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Logger;
}

describe('RateLimitGuard', () => {
  it('passes routes with no @RateLimit metadata straight through without touching Redis', async () => {
    const redis = { client: { incr: vi.fn() } } as unknown as RedisService;
    const guard = new RateLimitGuard(createReflector(undefined), redis, createLogger());

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
    expect(redis.client.incr).not.toHaveBeenCalled();
  });

  it('allows requests under the limit', async () => {
    const redis = {
      client: { incr: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(1) },
    } as unknown as RedisService;
    const options: RateLimitOptions = { limit: 5, windowSeconds: 60 };
    const guard = new RateLimitGuard(createReflector(options), redis, createLogger());

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
  });

  it('throws RateLimitedError with Retry-After once the limit is exceeded', async () => {
    const redis = {
      client: {
        incr: vi.fn().mockResolvedValue(6),
        expire: vi.fn(),
        ttl: vi.fn().mockResolvedValue(42),
      },
    } as unknown as RedisService;
    const options: RateLimitOptions = { limit: 5, windowSeconds: 60 };
    const guard = new RateLimitGuard(createReflector(options), redis, createLogger());

    await expect(guard.canActivate(createContext())).rejects.toThrow(RateLimitedError);
  });

  it('fails OPEN — allows the request through — when Redis is unreachable, instead of taking down the whole route', async () => {
    const redis = {
      client: { incr: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) },
    } as unknown as RedisService;
    const options: RateLimitOptions = { limit: 5, windowSeconds: 60 };
    const logger = createLogger();
    const guard = new RateLimitGuard(createReflector(options), redis, logger);

    await expect(guard.canActivate(createContext())).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});
