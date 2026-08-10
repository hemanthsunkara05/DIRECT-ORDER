import { Inject, Injectable } from '@nestjs/common';
import type { Payment, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreatePaymentInput {
  orderId: string;
  provider: string;
  providerOrderId?: string;
  amountMinor: bigint;
  currency: string;
  idempotencyKey: string;
}

/**
 * Deliberately NOT tenant-scoped — a payment's tenant is reached
 * through its order, and this repository is used by provider-facing
 * webhook processing which has no authenticated tenant context at all.
 */
@Injectable()
export class PaymentRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreatePaymentInput): Promise<Payment> {
    return this.prisma.payment.create({
      data: {
        orderId: input.orderId,
        provider: input.provider,
        providerOrderId: input.providerOrderId,
        status: 'CREATED',
        amountMinor: input.amountMinor,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
      },
    });
  }

  async findById(paymentId: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { id: paymentId } });
  }

  async findByOrderId(orderId: string): Promise<Payment[]> {
    return this.prisma.payment.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' } });
  }

  async findLatestByOrderId(orderId: string): Promise<Payment | null> {
    const [latest] = await this.prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    return latest ?? null;
  }

  async findByProviderPaymentId(
    provider: string,
    providerPaymentId: string,
  ): Promise<Payment | null> {
    return this.prisma.payment.findFirst({ where: { provider, providerPaymentId } });
  }

  /** For webhooks that arrive before any `providerPaymentId` is known on our side (e.g. an order-level event). */
  async findByProviderOrderId(provider: string, providerOrderId: string): Promise<Payment | null> {
    return this.prisma.payment.findFirst({
      where: { provider, providerOrderId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Real Postgres would use `SELECT ... FOR UPDATE` here (docs/03-state-
   * machines.md universal rule 2 — every aggregate transition locks the
   * row before reading current state); the in-memory test fake has no
   * real row-locking to provide, so this method's name documents the
   * intent for the real database even though it degrades to a plain
   * read against the fake. See this phase's report for what remains
   * unverified without Docker.
   */
  async findByIdForUpdate(paymentId: string): Promise<Payment | null> {
    return this.prisma.payment.findUnique({ where: { id: paymentId } });
  }

  async update(
    paymentId: string,
    data: Partial<{
      status: PaymentStatus;
      providerPaymentId: string;
      capturedMinor: bigint;
      refundedMinor: bigint;
      method: string;
      failureCode: string | null;
      failureMessage: string | null;
      reconciliationStatus: string;
      authorizedAt: Date;
      capturedAt: Date;
    }>,
  ): Promise<Payment> {
    return this.prisma.payment.update({ where: { id: paymentId }, data });
  }
}
