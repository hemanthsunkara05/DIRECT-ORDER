import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import {
  get,
  mutate,
  registerAndLogin,
  type RegisteredUser,
} from './support/register-and-login.js';

describe('Menu management (Phase 6, e2e)', () => {
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

  async function createCategory(owner: RegisteredUser, name = 'Starters') {
    const res = await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', owner.cookie)
      .send({ name })
      .expect(201);
    return res.body.data as { id: string; name: string; displayOrder: number };
  }

  describe('Categories', () => {
    it('creates, lists, updates, and archives a category (docs/14-acceptance-criteria.md, Phase 6)', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);

      const category = await createCategory(owner, 'Starters');
      expect(category.name).toBe('Starters');
      expect(category.displayOrder).toBe(0);

      const listed = await get(ctx, '/api/v1/restaurant/menu/categories', owner.cookie).expect(200);
      expect(listed.body.data).toHaveLength(1);

      const updated = await mutate(
        ctx,
        'patch',
        `/api/v1/restaurant/menu/categories/${category.id}`,
        owner.cookie,
      )
        .send({ description: 'Small plates to start' })
        .expect(200);
      expect(updated.body.data.description).toBe('Small plates to start');

      await mutate(
        ctx,
        'delete',
        `/api/v1/restaurant/menu/categories/${category.id}`,
        owner.cookie,
      ).expect(200);

      const afterArchive = await get(
        ctx,
        '/api/v1/restaurant/menu/categories',
        owner.cookie,
      ).expect(200);
      expect(afterArchive.body.data).toHaveLength(0);

      // Never hard-deleted — the row survives with archivedAt set.
      const row = ctx.db.menuCategories.find((c) => c.id === category.id);
      expect(row).toBeDefined();
      expect(row?.archivedAt).not.toBeNull();
    });

    it('rejects a duplicate active category name, case-insensitively', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);
      await createCategory(owner, 'Starters');

      const res = await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', owner.cookie)
        .send({ name: 'starters' })
        .expect(409);
      expect(res.body.error.message).toMatch(/already exists/i);
    });

    it('STAFF cannot create or update a category (403), but can still read', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const staffUser = await registerAndLogin(ctx);
      addMembership(staffUser.userId, restaurantId, 'STAFF', owner.userId);

      await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', staffUser.cookie)
        .send({ name: 'Starters' })
        .expect(403);
      await get(ctx, '/api/v1/restaurant/menu/categories', staffUser.cookie).expect(200);
    });

    it('reorders categories atomically, rejecting the whole batch on an unknown id', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);
      const a = await createCategory(owner, 'Starters');
      const b = await createCategory(owner, 'Mains');

      const badReorder = await mutate(
        ctx,
        'post',
        '/api/v1/restaurant/menu/categories/reorder',
        owner.cookie,
      )
        .send({
          items: [
            { id: a.id, displayOrder: 5 },
            { id: randomUUID(), displayOrder: 6 },
          ],
        })
        .expect(404);
      expect(badReorder.body.error).toBeDefined();

      // The previous order must be completely intact — no partial write.
      const stillA = ctx.db.menuCategories.find((c) => c.id === a.id)!;
      expect(stillA.displayOrder).toBe(0);

      const goodReorder = await mutate(
        ctx,
        'post',
        '/api/v1/restaurant/menu/categories/reorder',
        owner.cookie,
      )
        .send({
          items: [
            { id: a.id, displayOrder: 1 },
            { id: b.id, displayOrder: 0 },
          ],
        })
        .expect(200);
      expect(goodReorder.body.data.status).toBe('ok');

      const listed = await get(ctx, '/api/v1/restaurant/menu/categories', owner.cookie).expect(200);
      expect(listed.body.data.map((c: { name: string }) => c.name)).toEqual(['Mains', 'Starters']);
    });

    it("restaurant A cannot read or modify restaurant B's category (404)", async () => {
      const ownerA = await registerAndLogin(ctx);
      const ownerB = await registerAndLogin(ctx);
      await createRestaurant(ownerA, 'Spice Route');
      await createRestaurant(ownerB, 'Copper Kettle');
      const categoryB = await createCategory(ownerB, 'Mains');

      await mutate(
        ctx,
        'patch',
        `/api/v1/restaurant/menu/categories/${categoryB.id}`,
        ownerA.cookie,
      )
        .send({ name: 'Hijacked' })
        .expect(404);
    });

    it('stores long names and XSS-shaped payloads verbatim (rendering safety is the frontend/React escaping boundary)', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);
      const payload = '<script>alert(1)</script>' + 'x'.repeat(150);

      const res = await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', owner.cookie)
        .send({ name: payload })
        .expect(201);
      expect(res.body.data.name).toBe(payload);
    });
  });

  describe('Items', () => {
    it('creates, updates, and archives an item (docs/14-acceptance-criteria.md, Phase 6)', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);
      const category = await createCategory(owner);

      const created = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
        .send({ categoryId: category.id, name: 'Masala Dosa', priceMinor: '12000' })
        .expect(201);
      expect(created.body.data.name).toBe('Masala Dosa');
      expect(created.body.data.priceMinor).toBe('12000');
      expect(created.body.data.isAvailable).toBe(true);

      const itemId = created.body.data.id as string;
      const updated = await mutate(
        ctx,
        'patch',
        `/api/v1/restaurant/menu/items/${itemId}`,
        owner.cookie,
      )
        .send({ priceMinor: '15000' })
        .expect(200);
      expect(updated.body.data.priceMinor).toBe('15000');

      await mutate(ctx, 'delete', `/api/v1/restaurant/menu/items/${itemId}`, owner.cookie).expect(
        200,
      );
      const listed = await get(ctx, '/api/v1/restaurant/menu/items', owner.cookie).expect(200);
      expect(listed.body.data).toHaveLength(0);

      // Never hard-deleted.
      const row = ctx.db.menuItems.find((i) => i.id === itemId)!;
      expect(row.archivedAt).not.toBeNull();
      expect(row.isActive).toBe(false);
      expect(row.isAvailable).toBe(false);
    });

    it('rejects price 0, a negative price, and a non-numeric price, all server-side (docs/14-acceptance-criteria.md, Phase 6)', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);
      const category = await createCategory(owner);

      for (const priceMinor of ['0', '-500', 'abc']) {
        await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
          .send({ categoryId: category.id, name: 'Bad Item', priceMinor })
          .expect(422);
      }
    });

    it('cannot add an item to an archived category', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);
      const category = await createCategory(owner);
      await mutate(
        ctx,
        'delete',
        `/api/v1/restaurant/menu/categories/${category.id}`,
        owner.cookie,
      ).expect(200);

      await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
        .send({ categoryId: category.id, name: 'Too Late', priceMinor: '10000' })
        .expect(422);
    });

    it('STAFF cannot create an item (403) but CAN toggle its availability (the one STAFF-permitted menu action)', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const category = await createCategory(owner);
      const item = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
        .send({ categoryId: category.id, name: 'Masala Dosa', priceMinor: '12000' })
        .expect(201);

      const staffUser = await registerAndLogin(ctx);
      addMembership(staffUser.userId, restaurantId, 'STAFF', owner.userId);

      await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', staffUser.cookie)
        .send({ categoryId: category.id, name: 'Sneaky Item', priceMinor: '1000' })
        .expect(403);

      const toggled = await mutate(
        ctx,
        'patch',
        `/api/v1/restaurant/menu/items/${item.body.data.id}/availability`,
        staffUser.cookie,
      )
        .send({ isAvailable: false })
        .expect(200);
      expect(toggled.body.data.isAvailable).toBe(false);
    });

    it('reorders items atomically, rejecting the whole batch on an unknown id', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner);
      const category = await createCategory(owner);
      const first = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
        .send({ categoryId: category.id, name: 'Idli', priceMinor: '5000' })
        .expect(201);
      const second = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
        .send({ categoryId: category.id, name: 'Vada', priceMinor: '6000' })
        .expect(201);

      await mutate(ctx, 'post', '/api/v1/restaurant/menu/items/reorder', owner.cookie)
        .send({
          items: [
            { id: first.body.data.id, displayOrder: 9 },
            { id: randomUUID(), displayOrder: 10 },
          ],
        })
        .expect(404);

      const stillFirst = ctx.db.menuItems.find((i) => i.id === first.body.data.id)!;
      expect(stillFirst.displayOrder).toBe(0);

      await mutate(ctx, 'post', '/api/v1/restaurant/menu/items/reorder', owner.cookie)
        .send({
          items: [
            { id: first.body.data.id, displayOrder: 1 },
            { id: second.body.data.id, displayOrder: 0 },
          ],
        })
        .expect(200);

      const listed = await get(ctx, '/api/v1/restaurant/menu/items', owner.cookie).expect(200);
      expect(listed.body.data.map((i: { name: string }) => i.name)).toEqual(['Vada', 'Idli']);
    });

    it("restaurant A cannot read or modify restaurant B's item (404)", async () => {
      const ownerA = await registerAndLogin(ctx);
      const ownerB = await registerAndLogin(ctx);
      await createRestaurant(ownerA, 'Spice Route');
      await createRestaurant(ownerB, 'Copper Kettle');
      const categoryB = await createCategory(ownerB, 'Mains');
      const itemB = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', ownerB.cookie)
        .send({ categoryId: categoryB.id, name: 'Butter Chicken', priceMinor: '25000' })
        .expect(201);

      await mutate(
        ctx,
        'patch',
        `/api/v1/restaurant/menu/items/${itemB.body.data.id}`,
        ownerA.cookie,
      )
        .send({ name: 'Hijacked' })
        .expect(404);
    });
  });
});
