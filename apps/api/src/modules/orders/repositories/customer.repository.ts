import { Inject, Injectable } from '@nestjs/common';
import type { Customer } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateGuestCustomerInput {
  fullName: string;
  phone: string;
  email?: string;
}

export interface CreateAccountCustomerInput {
  userId: string;
  fullName: string;
  phone: string;
  email?: string;
}

/**
 * AMB-2: guest checkout is the default; `createGuest` (`userId: null`)
 * remains every checkout's path when no logged-in customer is present.
 * Phase 16 adds the registered-account path (`createAccount`) — AMB-2's
 * "lightweight optional account", phone-OTP, no password. The two
 * creation paths are deliberately separate methods, not one method with
 * an optional `userId`: AMB-2 explicitly recommends against retroactively
 * merging a phone's prior guest history into a new account ("Recommend
 * no for v1 — the deduplication and fraud surface is not worth it"), so
 * there is no shared lookup-or-create branch worth factoring out.
 *
 * Re-provided directly in every module that needs it (OrdersModule,
 * NotificationsModule, PublicModule, and now CustomerAuthModule/
 * LoyaltyModule) rather than pulled from one shared module — this
 * class is thin, stateless, and PrismaService-backed, so a second
 * Nest-managed instance is exactly as correct as sharing another
 * module's (see NotificationsModule's own doc comment for the
 * original statement of this call, made for this exact class).
 */
@Injectable()
export class CustomerRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createGuest(input: CreateGuestCustomerInput): Promise<Customer> {
    return this.prisma.customer.create({
      data: {
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        status: 'ACTIVE',
      },
    });
  }

  /**
   * Called only from `CustomerAuthService.verifyOtp()` the first time a
   * given phone completes `CUSTOMER_LOGIN` OTP verification.
   */
  async createAccount(input: CreateAccountCustomerInput): Promise<Customer> {
    return this.prisma.customer.create({
      data: {
        userId: input.userId,
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        status: 'ACTIVE',
      },
    });
  }

  async findById(id: string): Promise<Customer | null> {
    return this.prisma.customer.findUnique({ where: { id } });
  }

  /** Batch lookup for a page of results (e.g. review authors) — avoids an N+1 of individual findById calls. */
  async findByIds(ids: string[]): Promise<Customer[]> {
    if (ids.length === 0) return [];
    return this.prisma.customer.findMany({ where: { id: { in: ids } } });
  }

  /** The account-resolution lookup every `/me/*` route and `CustomerAccountGuard` uses — `userId` is `@unique`, so at most one row. */
  async findByUserId(userId: string): Promise<Customer | null> {
    return this.prisma.customer.findUnique({ where: { userId } });
  }
}
