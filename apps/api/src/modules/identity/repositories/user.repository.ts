import { Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateUserInput {
  email: string;
  fullName: string;
  passwordHash: string;
}

/**
 * Users are platform-level, not restaurant-scoped — a plain repository,
 * not a TenantScopedRepository (Phase 2's pattern applies to
 * restaurant-owned data; identity is not restaurant-owned).
 */
@Injectable()
export class UserRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateUserInput): Promise<User> {
    return this.prisma.user.create({ data: input });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findByPhone(phone: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { phone } });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async markEmailVerified(id: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { emailVerifiedAt: new Date() } });
  }

  async markPhoneVerified(id: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { phoneVerifiedAt: new Date() } });
  }

  async updatePasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
  }

  async recordLogin(id: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
  }
}
