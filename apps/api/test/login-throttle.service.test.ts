import { describe, expect, it } from 'vitest';
import { LoginThrottleService } from '../src/modules/identity/services/login-throttle.service.js';
import { createFakeRedisService } from './support/fake-redis.js';

describe('LoginThrottleService', () => {
  it('is not locked before any failures are recorded', async () => {
    const service = new LoginThrottleService(createFakeRedisService());
    await expect(service.isLocked('owner@restaurant.test')).resolves.toBe(false);
  });

  it('locks the identifier after 10 recorded failures (docs/09-security.md §15.2)', async () => {
    const service = new LoginThrottleService(createFakeRedisService());
    for (let i = 0; i < 9; i++) {
      await service.recordFailure('owner@restaurant.test');
    }
    await expect(service.isLocked('owner@restaurant.test')).resolves.toBe(false);

    await service.recordFailure('owner@restaurant.test');
    await expect(service.isLocked('owner@restaurant.test')).resolves.toBe(true);
  });

  it('reset() clears the lockout', async () => {
    const service = new LoginThrottleService(createFakeRedisService());
    for (let i = 0; i < 10; i++) {
      await service.recordFailure('owner@restaurant.test');
    }
    await service.reset('owner@restaurant.test');
    await expect(service.isLocked('owner@restaurant.test')).resolves.toBe(false);
  });

  it('is keyed per-identifier — failures on one account do not lock another', async () => {
    const service = new LoginThrottleService(createFakeRedisService());
    for (let i = 0; i < 10; i++) {
      await service.recordFailure('victim@restaurant.test');
    }
    await expect(service.isLocked('someone-else@restaurant.test')).resolves.toBe(false);
  });

  it('is case-insensitive on the identifier', async () => {
    const service = new LoginThrottleService(createFakeRedisService());
    for (let i = 0; i < 10; i++) {
      await service.recordFailure('Owner@Restaurant.test');
    }
    await expect(service.isLocked('owner@restaurant.test')).resolves.toBe(true);
  });
});
