import { describe, expect, it } from 'vitest';
import type { Env } from '../src/platform/config/env.schema.js';
import { PasswordService } from '../src/modules/identity/services/password.service.js';

function createService(memoryKb = 8192): PasswordService {
  // A much smaller memory cost than the production default (65536 KB)
  // — correctness of the hash/verify round trip does not depend on the
  // cost parameter, and a small value keeps this test fast.
  return new PasswordService({ ARGON2_MEMORY_KB: memoryKb } as Env);
}

describe('PasswordService', () => {
  it('hashes a password and verifies the same password against it', async () => {
    const service = createService();
    const hash = await service.hash('a-reasonably-strong-password');
    await expect(service.verify(hash, 'a-reasonably-strong-password')).resolves.toBe(true);
  });

  it('rejects the wrong password against a real hash', async () => {
    const service = createService();
    const hash = await service.hash('a-reasonably-strong-password');
    await expect(service.verify(hash, 'a-different-password')).resolves.toBe(false);
  });

  it('never persists the password in plaintext — the hash does not contain it', async () => {
    const service = createService();
    const hash = await service.hash('a-reasonably-strong-password');
    expect(hash).not.toContain('a-reasonably-strong-password');
  });

  it('treats a malformed hash as a non-match instead of throwing', async () => {
    const service = createService();
    await expect(service.verify('not-a-real-argon2-hash', 'anything')).resolves.toBe(false);
  });

  it('rejects passwords shorter than the minimum length', () => {
    const service = createService();
    const issues = service.validatePolicy('short1');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects common passwords even if long enough', () => {
    const service = createService();
    const issues = service.validatePolicy('password123');
    expect(issues.length).toBeGreaterThan(0);
  });

  it('accepts a password meeting length and not on the common list', () => {
    const service = createService();
    expect(service.validatePolicy('a-perfectly-cromulent-passphrase')).toEqual([]);
  });
});
