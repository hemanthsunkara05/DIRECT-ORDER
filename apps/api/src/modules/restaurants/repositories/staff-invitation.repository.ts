import { Inject, Injectable } from '@nestjs/common';
import {
  StaffInvitationStatus,
  type RestaurantStaffRole,
  type StaffInvitation,
} from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export interface CreateStaffInvitationInput {
  email: string;
  role: RestaurantStaffRole;
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: Date;
}

/**
 * `findByTokenHash` is deliberately NOT tenant-scoped — same reasoning
 * as OtpChallengeRepository.findLatestUnconsumedByHash (Phase 3): the
 * invitation link a recipient clicks carries only the token, not a
 * restaurant ID, so the lookup has to go by hash alone. Everything else
 * here is a normal tenant-scoped operation.
 */
@Injectable()
export class StaffInvitationRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async create(restaurantId: string, input: CreateStaffInvitationInput): Promise<StaffInvitation> {
    return this.prisma.staffInvitation.create({
      data: this.withTenant(restaurantId, { ...input }),
    });
  }

  async findByTokenHash(tokenHash: string): Promise<StaffInvitation | null> {
    return this.prisma.staffInvitation.findUnique({ where: { tokenHash } });
  }

  async findPendingByEmail(restaurantId: string, email: string): Promise<StaffInvitation | null> {
    return this.prisma.staffInvitation.findFirst({
      where: this.withTenant(restaurantId, { email, status: StaffInvitationStatus.PENDING }),
    });
  }

  async list(restaurantId: string, options: { limit?: number } = {}): Promise<StaffInvitation[]> {
    return this.prisma.staffInvitation.findMany({
      where: this.withTenant(restaurantId, {}),
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 20, 100),
    });
  }

  async markAccepted(id: string): Promise<void> {
    await this.prisma.staffInvitation.update({
      where: { id },
      data: { status: StaffInvitationStatus.ACCEPTED, acceptedAt: new Date() },
    });
  }

  async revoke(restaurantId: string, id: string): Promise<boolean> {
    const result = await this.prisma.staffInvitation.updateMany({
      where: this.withTenant(restaurantId, { id, status: StaffInvitationStatus.PENDING }),
      data: { status: StaffInvitationStatus.REVOKED, revokedAt: new Date() },
    });
    return result.count > 0;
  }
}
