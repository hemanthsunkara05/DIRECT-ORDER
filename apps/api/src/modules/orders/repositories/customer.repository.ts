import { Inject, Injectable } from '@nestjs/common';
import type { Customer } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateGuestCustomerInput {
  fullName: string;
  phone: string;
  email?: string;
}

/**
 * AMB-2: guest checkout is the pilot default; a persistent, registered
 * "lightweight optional account" (phone-OTP) is explicitly deferred
 * past the pilot — no phase in the 20-phase list covers it. Every
 * checkout in this phase therefore creates a fresh guest Customer row
 * (`userId: null`) rather than looking one up; there is no login to
 * look one up against yet.
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

  async findById(id: string): Promise<Customer | null> {
    return this.prisma.customer.findUnique({ where: { id } });
  }
}
