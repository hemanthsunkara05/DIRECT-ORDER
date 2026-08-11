import { Inject, Injectable } from '@nestjs/common';
import type { Session } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { generateId } from '../../../platform/ids/generate-id.js';

export interface CreateSessionInput {
  userId: string;
  /**
   * Omit for a brand-new login — the repository generates the row's id
   * and uses it as its own familyId, so a fresh login always starts a
   * new family. Pass the existing family's id when rotating.
   */
  familyId?: string;
  refreshTokenHash: string;
  expiresAt: Date;
  userAgent?: string;
  ipHash?: string;
  rotatedFromId?: string;
}

/**
 * Sessions belong to a User, not a restaurant tenant — this is a plain
 * repository, not a TenantScopedRepository (Phase 2).
 */
@Injectable()
export class SessionRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const id = generateId();
    return this.prisma.session.create({
      data: { ...input, id, familyId: input.familyId ?? id },
    });
  }

  async findByHash(refreshTokenHash: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { refreshTokenHash } });
  }

  async findById(id: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { id } });
  }

  /**
   * Revokes the currently-presented session and creates its successor
   * in one transaction — must be atomic. A partial failure here (old
   * revoked, new never created, or vice versa) would either strand the
   * client with no valid token or break the invariant reuse detection
   * depends on: a revoked token was always already exchanged for
   * exactly one successor.
   */
  async rotate(oldSessionId: string, next: CreateSessionInput): Promise<Session> {
    const id = generateId();
    const [, created] = await this.prisma.$transaction([
      this.prisma.session.update({
        where: { id: oldSessionId },
        data: { revokedAt: new Date() },
      }),
      this.prisma.session.create({
        data: { ...next, id, familyId: next.familyId ?? id },
      }),
    ]);
    return created;
  }

  async revoke(id: string, reason?: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeAllForUser(userId: string, reason: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Phase 13: marks THIS session as having completed MFA — see AuthorizationGuard's own doc comment for why this is per-session, not per-user. */
  async markMfaVerified(id: string): Promise<void> {
    await this.prisma.session.update({ where: { id }, data: { mfaVerifiedAt: new Date() } });
  }
}
