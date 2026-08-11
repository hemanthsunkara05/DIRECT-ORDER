import { Inject, Injectable } from '@nestjs/common';
import type { AdminRole, AdminUser, User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';

export type AdminUserWithUser = AdminUser & { user: Pick<User, 'id' | 'fullName' | 'email'> };

/**
 * The admin-side mirror of `RestaurantMembershipRepository` — same
 * reasoning: lives in the platform layer, not a domain module, because
 * `AuthorizationGuard` (a cross-cutting concern every route depends on)
 * needs it without importing a domain module (docs/12-repository-
 * structure.md's dependency-direction rule).
 */
@Injectable()
export class AdminUserRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findByUserId(userId: string): Promise<AdminUser | null> {
    return this.prisma.adminUser.findUnique({ where: { userId } });
  }

  /** `null` covers both "no AdminUser row" and "DISABLED" — a route only ever needs to know "usable admin role, or not." */
  async findActiveRoleByUserId(userId: string): Promise<AdminRole | null> {
    const row = await this.prisma.adminUser.findUnique({ where: { userId } });
    return row && row.status === 'ACTIVE' ? row.role : null;
  }

  async countActiveByRole(role: AdminRole): Promise<number> {
    return this.prisma.adminUser.count({ where: { role, status: 'ACTIVE' } });
  }

  async create(userId: string, role: AdminRole): Promise<AdminUser> {
    return this.prisma.adminUser.create({ data: { userId, role } });
  }

  async list(options: { limit?: number } = {}): Promise<AdminUserWithUser[]> {
    return this.prisma.adminUser.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 20, 100),
      include: { user: { select: { id: true, fullName: true, email: true } } },
    });
  }

  async setStatus(id: string, status: 'ACTIVE' | 'DISABLED'): Promise<AdminUser> {
    return this.prisma.adminUser.update({ where: { id }, data: { status } });
  }
}
