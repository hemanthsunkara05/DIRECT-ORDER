import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import {
  get,
  mutate,
  registerAndLogin,
  type RegisteredUser,
} from './support/register-and-login.js';

describe('Restaurant hours, closures, and availability (Phase 7, e2e)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  async function createRestaurant(owner: RegisteredUser, name = 'Spice Route'): Promise<string> {
    const res = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name })
      .expect(201);
    return res.body.data.id as string;
  }

  function addMembership(
    userId: string,
    restaurantId: string,
    role: 'STAFF' | 'MANAGER' | 'OWNER',
    invitedByUserId: string,
  ) {
    ctx.db.restaurantStaff.push({
      id: randomUUID(),
      userId,
      restaurantId,
      role,
      status: 'ACTIVE',
      invitedByUserId,
      joinedAt: new Date(),
      disabledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  describe('GET/PUT /restaurant/hours', () => {
    it('replaces the full weekly schedule and persists it', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);

      const before = await get(ctx, '/api/v1/restaurant/hours', owner.cookie).expect(200);
      expect(before.body.data).toEqual([]);

      const put = await mutate(ctx, 'put', '/api/v1/restaurant/hours', owner.cookie)
        .send({
          days: [
            { dayOfWeek: 1, opensAt: '11:00', closesAt: '23:00' },
            { dayOfWeek: 2, opensAt: '11:00', closesAt: '23:00' },
          ],
        })
        .expect(200);
      expect(put.body.data).toHaveLength(2);

      // A second PUT fully replaces the first — not merges.
      const replaced = await mutate(ctx, 'put', '/api/v1/restaurant/hours', owner.cookie)
        .send({ days: [{ dayOfWeek: 3, opensAt: '09:00', closesAt: '21:00' }] })
        .expect(200);
      expect(replaced.body.data).toHaveLength(1);
      expect(replaced.body.data[0].dayOfWeek).toBe(3);

      const after = await get(ctx, '/api/v1/restaurant/hours', owner.cookie).expect(200);
      expect(after.body.data).toHaveLength(1);
    });

    it('rejects an identical opensAt/closesAt for a non-closed shift', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);

      await mutate(ctx, 'put', '/api/v1/restaurant/hours', owner.cookie)
        .send({ days: [{ dayOfWeek: 1, opensAt: '11:00', closesAt: '11:00' }] })
        .expect(422);
    });

    it('STAFF cannot read or write hours (MANAGER-only, docs/04-api-specification.md §8.5)', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const staffUser = await registerAndLogin(ctx);
      addMembership(staffUser.userId, restaurantId, 'STAFF', owner.userId);

      await get(ctx, '/api/v1/restaurant/hours', staffUser.cookie).expect(403);
      await mutate(ctx, 'put', '/api/v1/restaurant/hours', staffUser.cookie)
        .send({ days: [] })
        .expect(403);
    });
  });

  describe('POST/GET/DELETE /restaurant/closures', () => {
    it('creates, lists, and ends a closure early', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);

      const created = await mutate(ctx, 'post', '/api/v1/restaurant/closures', owner.cookie)
        .send({ startsAt: '2026-01-01T00:00:00.000Z', reason: 'Gas leak' })
        .expect(201);
      expect(created.body.data.endsAt).toBeNull();

      const listed = await get(ctx, '/api/v1/restaurant/closures', owner.cookie).expect(200);
      expect(listed.body.data).toHaveLength(1);

      await mutate(
        ctx,
        'delete',
        `/api/v1/restaurant/closures/${created.body.data.id}`,
        owner.cookie,
      ).expect(200);

      const closure = ctx.db.closurePeriods.find((c) => c.id === created.body.data.id)!;
      expect(closure.endsAt).not.toBeNull();
    });

    it('rejects endsAt at or before startsAt', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);

      await mutate(ctx, 'post', '/api/v1/restaurant/closures', owner.cookie)
        .send({ startsAt: '2026-01-02T00:00:00.000Z', endsAt: '2026-01-01T00:00:00.000Z' })
        .expect(422);
    });
  });

  describe('PATCH /restaurant/availability', () => {
    it('STAFF can toggle ordering_enabled (the one restaurant-level action STAFF holds)', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const staffUser = await registerAndLogin(ctx);
      addMembership(staffUser.userId, restaurantId, 'STAFF', owner.userId);

      const res = await mutate(ctx, 'patch', '/api/v1/restaurant/availability', staffUser.cookie)
        .send({ orderingEnabled: false })
        .expect(200);
      expect(res.body.data.orderingEnabled).toBe(false);

      const row = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
      expect(row.orderingEnabled).toBe(false);
    });

    it('toggling ordering_enabled to true cannot override a platform suspension', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const created = await get(ctx, '/api/v1/restaurant/profile', owner.cookie).expect(200);
      const slug = created.body.data.slug as string;

      // Wide-open hours so the only thing standing between this
      // restaurant and ACCEPTING is the suspension itself.
      await mutate(ctx, 'put', '/api/v1/restaurant/hours', owner.cookie)
        .send({
          days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            dayOfWeek,
            opensAt: '00:00',
            closesAt: '23:59',
          })),
        })
        .expect(200);
      // No admin-approval endpoint exists yet (Phase 13) — seed suspension directly.
      const row = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
      row.status = 'SUSPENDED';

      await mutate(ctx, 'patch', '/api/v1/restaurant/availability', owner.cookie)
        .send({ orderingEnabled: true })
        .expect(200);

      const publicProfile = await get(ctx, `/api/v1/public/restaurants/${slug}`).expect(200);
      expect(publicProfile.body.data.availability).toEqual({
        accepting: false,
        reason: 'SUSPENDED',
      });
    });
  });
});
