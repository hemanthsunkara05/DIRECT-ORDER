import { describe, expect, it } from 'vitest';
import { OtpChallengeRepository } from '../src/modules/identity/repositories/otp-challenge.repository.js';
import { OtpService } from '../src/modules/identity/services/otp.service.js';
import { createInMemoryPrisma } from './support/in-memory-prisma.js';

function createService() {
  const { prisma, otpChallenges } = createInMemoryPrisma();
  const repository = new OtpChallengeRepository(prisma);
  return { service: new OtpService(repository), otpChallenges };
}

describe('OtpService', () => {
  it('issues a 6-digit numeric code for EMAIL_VERIFICATION and verifies it', async () => {
    const { service } = createService();
    const issued = await service.request('owner@restaurant.test', 'EMAIL_VERIFICATION');
    expect(issued.secret).toMatch(/^\d{6}$/);

    const result = await service.verify(
      'owner@restaurant.test',
      'EMAIL_VERIFICATION',
      issued.secret,
    );
    expect(result).toBe('VERIFIED');
  });

  it('never persists the raw code — only its hash', async () => {
    const { service, otpChallenges } = createService();
    const issued = await service.request('owner@restaurant.test', 'PHONE_VERIFICATION');
    expect(otpChallenges[0]!.codeHash).not.toBe(issued.secret);
    expect(otpChallenges[0]!.codeHash).not.toContain(issued.secret);
  });

  it('rejects a wrong code as INVALID', async () => {
    const { service } = createService();
    await service.request('owner@restaurant.test', 'EMAIL_VERIFICATION');
    const result = await service.verify('owner@restaurant.test', 'EMAIL_VERIFICATION', '000000');
    expect(result).toBe('INVALID');
  });

  it('a challenge is single-use — verifying twice fails the second time', async () => {
    const { service } = createService();
    const issued = await service.request('owner@restaurant.test', 'EMAIL_VERIFICATION');
    await expect(
      service.verify('owner@restaurant.test', 'EMAIL_VERIFICATION', issued.secret),
    ).resolves.toBe('VERIFIED');
    await expect(
      service.verify('owner@restaurant.test', 'EMAIL_VERIFICATION', issued.secret),
    ).resolves.toBe('INVALID');
  });

  it('locks out after 5 wrong attempts (docs/09-security.md §15.2)', async () => {
    const { service } = createService();
    const issued = await service.request('owner@restaurant.test', 'EMAIL_VERIFICATION');

    for (let i = 0; i < 5; i++) {
      await service.verify('owner@restaurant.test', 'EMAIL_VERIFICATION', '000000');
    }

    const result = await service.verify(
      'owner@restaurant.test',
      'EMAIL_VERIFICATION',
      issued.secret,
    );
    expect(result).toBe('TOO_MANY_ATTEMPTS');
  });

  it('an expired challenge is rejected even with the correct code', async () => {
    const { service, otpChallenges } = createService();
    const issued = await service.request('owner@restaurant.test', 'EMAIL_VERIFICATION');
    otpChallenges[0]!.expiresAt = new Date(Date.now() - 1000);

    const result = await service.verify(
      'owner@restaurant.test',
      'EMAIL_VERIFICATION',
      issued.secret,
    );
    expect(result).toBe('EXPIRED');
  });

  it('PASSWORD_RESET issues a long opaque token, not a 6-digit code', async () => {
    const { service } = createService();
    const issued = await service.request('owner@restaurant.test', 'PASSWORD_RESET');
    expect(issued.secret.length).toBeGreaterThan(20);
    expect(issued.secret).not.toMatch(/^\d{6}$/);
  });

  it('verifyResetToken finds the challenge by token alone, with no identifier, and reveals the identifier on success', async () => {
    const { service } = createService();
    const issued = await service.request('owner@restaurant.test', 'PASSWORD_RESET');

    const result = await service.verifyResetToken(issued.secret);

    expect(result).toEqual({ outcome: 'VERIFIED', identifier: 'owner@restaurant.test' });
  });

  it('verifyResetToken is single-use', async () => {
    const { service } = createService();
    const issued = await service.request('owner@restaurant.test', 'PASSWORD_RESET');

    await service.verifyResetToken(issued.secret);
    const second = await service.verifyResetToken(issued.secret);

    expect(second).toEqual({ outcome: 'INVALID' });
  });

  it('an unknown reset token is INVALID', async () => {
    const { service } = createService();
    const result = await service.verifyResetToken('a-token-that-was-never-issued');
    expect(result).toEqual({ outcome: 'INVALID' });
  });
});
