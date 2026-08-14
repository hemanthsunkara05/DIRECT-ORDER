import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { SupportCase, SupportCaseCategory, SupportCasePriority, SupportCaseStatus } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Same shape as `generateOrderNumber` (orders/order-number.ts) — human-readable, hard to enumerate, `@@unique`-backed so a rare collision is caught and retried rather than silently accepted. */
export function generateCaseNumber(now: Date = new Date()): string {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const bytes = randomBytes(5);
  let suffix = '';
  for (let i = 0; i < 5; i++) suffix += CROCKFORD_BASE32[bytes[i]! % CROCKFORD_BASE32.length];
  return `CASE-${yy}${mm}${dd}-${suffix}`;
}

export interface CreateSupportCaseInput {
  caseNumber: string;
  customerId?: string;
  restaurantId?: string;
  orderId?: string;
  category: SupportCaseCategory;
  priority?: SupportCasePriority;
  subject: string;
  description: string;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function take(limit?: number): number {
  return Math.min(limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
}

/**
 * `docs/01-domain-model.md §5.12: "exactly one of customer_id/
 * restaurant_id identifies the reporter."` Enforced by construction,
 * not a database CHECK: `create` is only ever called from
 * `SupportCaseService.createForCustomer`/`createForRestaurant`, each
 * of which sets exactly one of the two ownership fields — there is no
 * shared "create with either" entry point a caller could misuse.
 */
@Injectable()
export class SupportCaseRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateSupportCaseInput): Promise<SupportCase> {
    return this.prisma.supportCase.create({
      data: {
        caseNumber: input.caseNumber,
        customerId: input.customerId,
        restaurantId: input.restaurantId,
        orderId: input.orderId,
        category: input.category,
        priority: input.priority ?? 'NORMAL',
        subject: input.subject,
        description: input.description,
      },
    });
  }

  async findById(id: string): Promise<SupportCase | null> {
    return this.prisma.supportCase.findUnique({ where: { id } });
  }

  /** BR-149 (cross-tenant access returns 404): returns `null` for a case that exists but belongs to a different customer, exactly like a nonexistent id — the caller cannot distinguish the two. */
  async findByIdForCustomer(id: string, customerId: string): Promise<SupportCase | null> {
    return this.prisma.supportCase.findFirst({ where: { id, customerId } });
  }

  async findByIdForRestaurant(id: string, restaurantId: string): Promise<SupportCase | null> {
    return this.prisma.supportCase.findFirst({ where: { id, restaurantId } });
  }

  async listForCustomer(customerId: string, options: { cursor?: string; limit?: number } = {}): Promise<Page<SupportCase>> {
    const limit = take(options.limit);
    const rows = await this.prisma.supportCase.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }

  async listForRestaurant(restaurantId: string, options: { cursor?: string; limit?: number } = {}): Promise<Page<SupportCase>> {
    const limit = take(options.limit);
    const rows = await this.prisma.supportCase.findMany({
      where: { restaurantId },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }

  /** The admin/agent queue (`GET /admin/support/cases`) — the one place cases are read WITHOUT a tenant/customer filter, deliberately, matching `AdminQueryRepository`'s own established exception. */
  async listForAdmin(
    filters: { status?: SupportCaseStatus; assignedToUserId?: string | null },
    options: { cursor?: string; limit?: number } = {},
  ): Promise<Page<SupportCase>> {
    const limit = take(options.limit);
    const rows = await this.prisma.supportCase.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.assignedToUserId !== undefined ? { assignedToUserId: filters.assignedToUserId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return toPage(rows, limit);
  }

  async updateStatus(id: string, status: SupportCaseStatus): Promise<SupportCase> {
    return this.prisma.supportCase.update({ where: { id }, data: { status } });
  }

  async assign(id: string, assignedToUserId: string): Promise<SupportCase> {
    return this.prisma.supportCase.update({
      where: { id },
      data: { assignedToUserId, status: 'ASSIGNED' },
    });
  }

  async resolve(id: string, resolutionNote: string): Promise<SupportCase> {
    return this.prisma.supportCase.update({
      where: { id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolutionNote },
    });
  }

  /** Set exactly once — the first PUBLIC agent message (docs/03 §7.9's SLA definition). Callers only invoke this when `firstResponseAt` is still null; no guard here against overwriting, matching this codebase's "the service enforces the rule, the repository just writes" split. */
  async setFirstResponseAt(id: string, at: Date): Promise<void> {
    await this.prisma.supportCase.update({ where: { id }, data: { firstResponseAt: at } });
  }
}

function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}
