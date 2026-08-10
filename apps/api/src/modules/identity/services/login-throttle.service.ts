import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '../../../platform/redis/redis.service.js';

const MAX_FAILURES = 10;
const WINDOW_SECONDS = 15 * 60;

/**
 * Per-account brute-force lockout (docs/09-security.md §15.2), distinct
 * from RateLimitGuard's per-IP window on the login route itself — an
 * attacker rotating IPs is still capped per target account. Keyed by the
 * lowercased identifier (email/phone) so it applies even before we know
 * whether the account exists, which is what keeps this check
 * enumeration-safe: the caller always runs it, account or not.
 */
@Injectable()
export class LoginThrottleService {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async isLocked(identifier: string): Promise<boolean> {
    const count = await this.redis.client.get(this.key(identifier));
    return count !== null && Number(count) >= MAX_FAILURES;
  }

  async recordFailure(identifier: string): Promise<void> {
    const key = this.key(identifier);
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, WINDOW_SECONDS);
    }
  }

  async reset(identifier: string): Promise<void> {
    await this.redis.client.del(this.key(identifier));
  }

  private key(identifier: string): string {
    return `login-throttle:${identifier.trim().toLowerCase()}`;
  }
}
