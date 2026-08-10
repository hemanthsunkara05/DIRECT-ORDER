import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import {
  get,
  mutate,
  registerAndLogin,
  type RegisteredUser,
} from './support/register-and-login.js';

const PUBLIC_RESTAURANT_ALLOWED_KEYS = [
  'slug',
  'name',
  'description',
  'timezone',
  'status',
  'avgPrepMinutes',
  'ratingAvg',
  'ratingCount',
  'availability',
  'address',
  'branding',
  'settings',
  'hours',
];

const PUBLIC_SETTINGS_ALLOWED_KEYS = [
  'minOrderAmountMinor',
  'packagingFeeMinor',
  'deliveryFeeMode',
  'deliveryFeeFlatMinor',
  'acceptsOnlinePayment',
];

describe('Public restaurant + menu (Phase 7, e2e)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  async function createOnboardedRestaurant(
    owner: RegisteredUser,
    name = 'Spice Route',
  ): Promise<{ id: string; slug: string }> {
    const res = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name })
      .expect(201);
    await mutate(ctx, 'patch', '/api/v1/restaurant/profile', owner.cookie)
      .send({
        address: {
          line1: '123 MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        },
      })
      .expect(200);
    return { id: res.body.data.id as string, slug: res.body.data.slug as string };
  }

  async function activate(restaurantId: string) {
    const row = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    row.status = 'ACTIVE';
    row.orderingEnabled = true;
  }

  describe('GET /public/restaurants/:slug', () => {
    it('a valid, active slug renders with an ACCEPTING decision when within hours', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurant = await createOnboardedRestaurant(owner);
      await activate(restaurant.id);
      await mutate(ctx, 'put', '/api/v1/restaurant/hours', owner.cookie)
        .send({
          days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            dayOfWeek,
            opensAt: '00:00',
            closesAt: '23:59',
          })),
        })
        .expect(200);

      const res = await get(ctx, `/api/v1/public/restaurants/${restaurant.slug}`).expect(200);
      expect(res.body.data.name).toBe('Spice Route');
      expect(res.body.data.availability.accepting).toBe(true);
      expect(res.body.data.address.city).toBe('Bengaluru');
    });

    it('an invalid slug 404s', async () => {
      await get(ctx, '/api/v1/public/restaurants/does-not-exist').expect(404);
    });

    it('a DRAFT (never-onboarded) restaurant 404s — not distinguishable from a nonexistent slug', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurant = await createOnboardedRestaurant(owner);
      // Deliberately not activated — status stays DRAFT.
      await get(ctx, `/api/v1/public/restaurants/${restaurant.slug}`).expect(404);
    });

    it('a SUSPENDED restaurant is still visible (200) but never accepting', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurant = await createOnboardedRestaurant(owner);
      await activate(restaurant.id);
      const row = ctx.db.restaurants.find((r) => r.id === restaurant.id)!;
      row.status = 'SUSPENDED';

      const res = await get(ctx, `/api/v1/public/restaurants/${restaurant.slug}`).expect(200);
      expect(res.body.data.status).toBe('SUSPENDED');
      expect(res.body.data.availability).toEqual({ accepting: false, reason: 'SUSPENDED' });
    });

    it('the response never leaks staff, settings beyond the public allowlist, or other internal data', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurant = await createOnboardedRestaurant(owner);
      await activate(restaurant.id);
      await mutate(ctx, 'patch', '/api/v1/restaurant/settings', owner.cookie)
        .send({ notificationEmails: ['owner@spiceroute.test'] })
        .expect(200);

      const res = await get(ctx, `/api/v1/public/restaurants/${restaurant.slug}`).expect(200);
      const data = res.body.data as Record<string, unknown>;

      expect(Object.keys(data).sort()).toEqual([...PUBLIC_RESTAURANT_ALLOWED_KEYS].sort());
      expect(Object.keys(data.settings as object).sort()).toEqual(
        [...PUBLIC_SETTINGS_ALLOWED_KEYS].sort(),
      );
      expect(JSON.stringify(data)).not.toContain('owner@spiceroute.test');
      expect(JSON.stringify(data)).not.toContain('autoAcceptOrders');
      expect(data).not.toHaveProperty('id');
    });
  });

  describe('GET /public/restaurants/:slug/menu', () => {
    async function createCategory(owner: RegisteredUser, name = 'Starters') {
      const res = await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', owner.cookie)
        .send({ name })
        .expect(201);
      return res.body.data as { id: string };
    }

    it('returns categories with their items, excluding archived items and categories', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurant = await createOnboardedRestaurant(owner);
      await activate(restaurant.id);
      const category = await createCategory(owner);
      const item = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
        .send({ categoryId: category.id, name: 'Masala Dosa', priceMinor: '12000' })
        .expect(201);
      const archivedItem = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
        .send({ categoryId: category.id, name: 'Discontinued Item', priceMinor: '5000' })
        .expect(201);
      await mutate(
        ctx,
        'delete',
        `/api/v1/restaurant/menu/items/${archivedItem.body.data.id}`,
        owner.cookie,
      ).expect(200);

      const res = await get(ctx, `/api/v1/public/restaurants/${restaurant.slug}/menu`).expect(200);
      expect(res.body.data.categories).toHaveLength(1);
      const items = res.body.data.categories[0].items as { id: string; name: string }[];
      expect(items.map((i) => i.name)).toEqual(['Masala Dosa']);
      expect(items[0]!.id).toBe(item.body.data.id);
    });

    it('includes an unavailable-but-active item, flagged, rather than hiding it (so it can be shown sold-out, not addable)', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurant = await createOnboardedRestaurant(owner);
      await activate(restaurant.id);
      const category = await createCategory(owner);
      const item = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
        .send({ categoryId: category.id, name: 'Sold Out Curry', priceMinor: '15000' })
        .expect(201);
      await mutate(
        ctx,
        'patch',
        `/api/v1/restaurant/menu/items/${item.body.data.id}/availability`,
        owner.cookie,
      )
        .send({ isAvailable: false })
        .expect(200);

      const res = await get(ctx, `/api/v1/public/restaurants/${restaurant.slug}/menu`).expect(200);
      const items = res.body.data.categories[0].items as { isAvailable: boolean }[];
      expect(items).toHaveLength(1);
      expect(items[0]!.isAvailable).toBe(false);
    });

    it('an invalid slug 404s', async () => {
      await get(ctx, '/api/v1/public/restaurants/does-not-exist/menu').expect(404);
    });
  });
});
