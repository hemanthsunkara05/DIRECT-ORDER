import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/platform/database/prisma.service.js';
import { AuditService } from '../src/platform/audit/audit.service.js';
import { requestContextStorage } from '../src/platform/logging/request-context.js';

function createPrismaStub() {
  return {
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-1' }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as any as PrismaService;
}

describe('AuditService', () => {
  it('exposes no update or delete method — append-only by construction (docs/02-database-schema.md, audit_logs)', () => {
    const methodNames = Object.getOwnPropertyNames(AuditService.prototype);
    for (const forbidden of ['update', 'delete', 'remove', 'patch', 'upsert']) {
      expect(methodNames).not.toContain(forbidden);
    }
  });

  it('record() writes exactly the provided fields to auditLog.create', async () => {
    const prisma = createPrismaStub();
    const service = new AuditService(prisma);

    await service.record({
      actorType: 'RESTAURANT_USER',
      actorId: 'user-1',
      action: 'RESTAURANT_STAFF_INVITED',
      entityType: 'RestaurantStaff',
      entityId: 'staff-1',
      restaurantId: 'restaurant-1',
      before: null,
      after: { role: 'STAFF' },
      reason: 'onboarding',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: 'RESTAURANT_USER',
        actorId: 'user-1',
        action: 'RESTAURANT_STAFF_INVITED',
        entityType: 'RestaurantStaff',
        entityId: 'staff-1',
        restaurantId: 'restaurant-1',
        after: { role: 'STAFF' },
        reason: 'onboarding',
      }),
    });
  });

  it('automatically fills correlationId from the current request context', async () => {
    const prisma = createPrismaStub();
    const service = new AuditService(prisma);

    await requestContextStorage.run({ requestId: 'req-audit-1' }, () =>
      service.record({
        actorType: 'SYSTEM',
        action: 'ORDER_STATE_CHANGED',
        entityType: 'Order',
      }),
    );

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ correlationId: 'req-audit-1' }),
    });
  });

  it('does not require a correlation ID to exist (system jobs outside a request)', async () => {
    const prisma = createPrismaStub();
    const service = new AuditService(prisma);

    await service.record({ actorType: 'SYSTEM', action: 'CRON_RAN', entityType: 'System' });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ correlationId: undefined }),
    });
  });

  it('findByEntity paginates and reports hasMore correctly', async () => {
    const prisma = createPrismaStub();
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `row-${i}` }));
    (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    const service = new AuditService(prisma);

    const page = await service.findByEntity('Order', 'order-1', { limit: 20 });

    expect(page.items).toHaveLength(20);
    expect(page.hasMore).toBe(true);
  });

  it('findByEntity reports hasMore=false when fewer rows than the limit exist', async () => {
    const prisma = createPrismaStub();
    (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'row-0' }]);
    const service = new AuditService(prisma);

    const page = await service.findByEntity('Order', 'order-1', { limit: 20 });

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });

  it('caps the page size at 100 regardless of the requested limit', async () => {
    const prisma = createPrismaStub();
    const service = new AuditService(prisma);

    await service.findByRestaurant('restaurant-1', { limit: 10_000 });

    const call = (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.take).toBe(101); // limit(100) + 1 lookahead row
  });
});
