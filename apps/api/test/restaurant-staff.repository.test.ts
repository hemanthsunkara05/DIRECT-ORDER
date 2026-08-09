import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../src/platform/database/prisma.service.js';
import { RestaurantStaffRepository } from '../src/modules/restaurants/repositories/restaurant-staff.repository.js';

function createPrismaStub() {
  return {
    restaurantStaff: {
      create: vi.fn().mockResolvedValue({ id: 'staff-1' }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  } as any as PrismaService;
}

describe('RestaurantStaffRepository — tenant scoping', () => {
  it('create() merges restaurantId into the persisted row', async () => {
    const prisma = createPrismaStub();
    const repo = new RestaurantStaffRepository(prisma);

    await repo.create('restaurant-A', { userId: 'user-1', role: 'OWNER' });

    expect(prisma.restaurantStaff.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        restaurantId: 'restaurant-A',
        userId: 'user-1',
        role: 'OWNER',
      }),
    });
  });

  it('findById() scopes the where clause by restaurantId, never returning a row from a different tenant', async () => {
    const prisma = createPrismaStub();
    const repo = new RestaurantStaffRepository(prisma);

    await repo.findById('restaurant-A', 'staff-1');

    expect(prisma.restaurantStaff.findFirst).toHaveBeenCalledWith({
      where: { id: 'staff-1', restaurantId: 'restaurant-A' },
    });
  });

  it('findActiveOwners() scopes by restaurantId in addition to role/status', async () => {
    const prisma = createPrismaStub();
    const repo = new RestaurantStaffRepository(prisma);

    await repo.findActiveOwners('restaurant-B');

    expect(prisma.restaurantStaff.findMany).toHaveBeenCalledWith({
      where: { role: 'OWNER', status: 'ACTIVE', restaurantId: 'restaurant-B' },
    });
  });

  it('countActiveOwners() scopes by restaurantId', async () => {
    const prisma = createPrismaStub();
    const repo = new RestaurantStaffRepository(prisma);

    await repo.countActiveOwners('restaurant-B');

    expect(prisma.restaurantStaff.count).toHaveBeenCalledWith({
      where: { role: 'OWNER', status: 'ACTIVE', restaurantId: 'restaurant-B' },
    });
  });

  it('list() scopes by restaurantId and bounds the page size', async () => {
    const prisma = createPrismaStub();
    const repo = new RestaurantStaffRepository(prisma);

    await repo.list('restaurant-A', { limit: 500 });

    const call = (prisma.restaurantStaff.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.where).toEqual({ restaurantId: 'restaurant-A' });
    expect(call.take).toBe(100);
  });

  it("two different restaurantIds never see each other's scoped query", async () => {
    const prisma = createPrismaStub();
    const repo = new RestaurantStaffRepository(prisma);

    await repo.findById('restaurant-A', 'staff-1');
    await repo.findById('restaurant-B', 'staff-1');

    const calls = (prisma.restaurantStaff.findFirst as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0].where.restaurantId).toBe('restaurant-A');
    expect(calls[1]![0].where.restaurantId).toBe('restaurant-B');
    expect(calls[0]![0].where.restaurantId).not.toBe(calls[1]![0].where.restaurantId);
  });
});
