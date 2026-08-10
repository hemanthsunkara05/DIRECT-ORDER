import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/platform/config/env.schema.js';
import { AuditService } from '../src/platform/audit/audit.service.js';
import { SessionRepository } from '../src/modules/identity/repositories/session.repository.js';
import { SessionService } from '../src/modules/identity/services/session.service.js';
import { TokenService } from '../src/modules/identity/services/token.service.js';
import { createInMemoryPrisma } from './support/in-memory-prisma.js';

function createHarness() {
  const { prisma, sessions, auditLogs } = createInMemoryPrisma();
  const env = {
    JWT_SECRET: 'a'.repeat(32),
    JWT_ACCESS_TTL_SECONDS: 900,
    REFRESH_TOKEN_TTL_DAYS: 30,
  } as Env;

  const tokens = new TokenService(env, new JwtService());
  const repository = new SessionRepository(prisma);
  const audit = new AuditService(prisma);
  const service = new SessionService(repository, tokens, audit, env);

  return { service, sessions, auditLogs };
}

describe('SessionService', () => {
  it('createSession starts a new family (familyId === the session id)', async () => {
    const { service, sessions } = createHarness();
    const { session } = await service.createSession('user-1');
    expect(sessions).toHaveLength(1);
    expect(session.familyId).toBe(session.id);
  });

  it('rotate() on a live session issues a new session in the same family and revokes the old one', async () => {
    const { service, sessions } = createHarness();
    const { session: first, refreshToken } = await service.createSession('user-1');

    const result = await service.rotate(refreshToken);

    expect(result.outcome).toBe('ROTATED');
    if (result.outcome !== 'ROTATED') throw new Error('unreachable');
    expect(result.issued.session.familyId).toBe(first.familyId);
    expect(result.issued.session.id).not.toBe(first.id);
    expect(sessions.find((s) => s.id === first.id)?.revokedAt).not.toBeNull();
  });

  it('rotate() with an unknown token returns INVALID', async () => {
    const { service } = createHarness();
    const result = await service.rotate('a-token-that-was-never-issued');
    expect(result.outcome).toBe('INVALID');
  });

  it('rotate() with an expired-but-unrevoked session returns EXPIRED', async () => {
    const { service, sessions } = createHarness();
    const { refreshToken } = await service.createSession('user-1');
    sessions[0]!.expiresAt = new Date(Date.now() - 1000);

    const result = await service.rotate(refreshToken);

    expect(result.outcome).toBe('EXPIRED');
  });

  it('reuse of an already-rotated token revokes the whole family and logs a security event (Phase 3 acceptance criterion)', async () => {
    const { service, sessions, auditLogs } = createHarness();
    const { refreshToken: originalToken } = await service.createSession('user-1');

    const first = await service.rotate(originalToken);
    if (first.outcome !== 'ROTATED') throw new Error('unreachable');

    // The original token was already exchanged for `first.issued` — presenting it again is reuse.
    const reuse = await service.rotate(originalToken);
    expect(reuse.outcome).toBe('REUSE_DETECTED');

    // The whole family — including the session issued by the first, legitimate rotation — is dead.
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(
      auditLogs.some(
        (entry) => entry.action === 'SESSION_REUSE_DETECTED' && entry.actorId === 'user-1',
      ),
    ).toBe(true);

    // The legitimately-rotated (second-generation) token no longer works either.
    const afterReuse = await service.rotate(first.issued.refreshToken);
    expect(afterReuse.outcome).toBe('REUSE_DETECTED');
  });

  it('revokeSession is idempotent for an unknown token', async () => {
    const { service } = createHarness();
    await expect(service.revokeSession('never-issued')).resolves.toBeUndefined();
  });

  it('revokeAllForUser revokes every live session for that user only', async () => {
    const { service, sessions } = createHarness();
    await service.createSession('user-1');
    await service.createSession('user-1');
    await service.createSession('user-2');

    await service.revokeAllForUser('user-1', 'PASSWORD_RESET');

    const user1Sessions = sessions.filter((s) => s.userId === 'user-1');
    const user2Sessions = sessions.filter((s) => s.userId === 'user-2');
    expect(user1Sessions.every((s) => s.revokedAt !== null)).toBe(true);
    expect(user2Sessions.every((s) => s.revokedAt === null)).toBe(true);
  });
});
