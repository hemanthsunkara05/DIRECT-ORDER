import type { RedisService } from '../../src/platform/redis/redis.service.js';

/**
 * In-memory stand-in for RedisService, implementing exactly the ioredis
 * subset RateLimitGuard and LoginThrottleService call (incr, expire, ttl,
 * get, del). Same rationale as in-memory-prisma.ts: no Docker/Redis
 * available in this sandbox, so the fixed-window rate-limit and
 * per-account lockout logic is exercised end-to-end against real
 * guard/service code, with only the Redis server itself faked.
 */
class FakeRedisClient {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  private read(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  incr(key: string): Promise<number> {
    const current = Number(this.read(key) ?? '0') + 1;
    const existing = this.store.get(key);
    this.store.set(key, { value: String(current), expiresAt: existing?.expiresAt ?? null });
    return Promise.resolve(current);
  }

  expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(0);
    entry.expiresAt = Date.now() + seconds * 1000;
    return Promise.resolve(1);
  }

  ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt === null) return Promise.resolve(-1);
    return Promise.resolve(Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000)));
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.read(key));
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.store.delete(key) ? 1 : 0);
  }
}

export function createFakeRedisService(): RedisService {
  return {
    client: new FakeRedisClient(),
    onModuleDestroy: () => Promise.resolve(),
  } as unknown as RedisService;
}
