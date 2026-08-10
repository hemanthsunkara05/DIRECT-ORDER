import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { mutate, registerAndLogin, type RegisteredUser } from './support/register-and-login.js';

describe('POST /public/checkout/quote (Phase 8, e2e)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  async function setUpRestaurant(
    owner: RegisteredUser,
    options: {
      minOrderAmountMinor?: number;
      packagingFeeMinor?: number;
      deliveryFeeFlatMinor?: number;
    } = {},
  ): Promise<{ slug: string; restaurantId: string; categoryId: string }> {
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Spice Route' })
      .expect(201);
    const restaurantId = created.body.data.id as string;
    const slug = created.body.data.slug as string;

    const row = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    row.status = 'ACTIVE';
    row.orderingEnabled = true;

    await mutate(ctx, 'put', '/api/v1/restaurant/hours', owner.cookie)
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '00:00',
          closesAt: '23:59',
        })),
      })
      .expect(200);

    if (
      options.minOrderAmountMinor !== undefined ||
      options.packagingFeeMinor !== undefined ||
      options.deliveryFeeFlatMinor !== undefined
    ) {
      await mutate(ctx, 'patch', '/api/v1/restaurant/settings', owner.cookie)
        .send({
          minOrderAmountMinor: options.minOrderAmountMinor,
          packagingFeeMinor: options.packagingFeeMinor,
          deliveryFeeMode: 'FLAT',
          deliveryFeeFlatMinor: options.deliveryFeeFlatMinor,
        })
        .expect(200);
    }

    const category = await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', owner.cookie)
      .send({ name: 'Mains' })
      .expect(201);

    return { slug, restaurantId, categoryId: category.body.data.id as string };
  }

  async function createItem(
    owner: RegisteredUser,
    categoryId: string,
    name: string,
    priceMinor: string,
  ) {
    const res = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
      .send({ categoryId, name, priceMinor })
      .expect(201);
    return res.body.data as { id: string; priceMinor: string };
  }

  it('prices a valid cart correctly, including packaging and delivery fees', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner, {
      packagingFeeMinor: 2000,
      deliveryFeeFlatMinor: 3000,
    });
    const item = await createItem(owner, categoryId, 'Masala Dosa', '12000');

    const res = await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.id, quantity: 2, unitPriceMinorAtAdd: '12000' }],
      })
      .expect(200);

    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.issues).toEqual([]);
    const { breakdown } = res.body.data;
    expect(breakdown.itemsSubtotalMinor).toBe('24000');
    expect(breakdown.packagingFeeMinor).toBe('2000');
    expect(breakdown.deliveryFeeMinor).toBe('3000');
    expect(breakdown.payableTotalMinor).toBe('29000');
  });

  it('flags an unavailable item without failing the whole quote, and excludes it from the breakdown', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner);
    const available = await createItem(owner, categoryId, 'Idli', '8000');
    const soldOut = await createItem(owner, categoryId, 'Vada', '7000');
    await mutate(
      ctx,
      'patch',
      `/api/v1/restaurant/menu/items/${soldOut.id}/availability`,
      owner.cookie,
    )
      .send({ isAvailable: false })
      .expect(200);

    const res = await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: slug,
        items: [
          { itemId: available.id, quantity: 1, unitPriceMinorAtAdd: '8000' },
          { itemId: soldOut.id, quantity: 1, unitPriceMinorAtAdd: '7000' },
        ],
      })
      .expect(200);

    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.issues).toEqual([{ code: 'ITEM_UNAVAILABLE', itemId: soldOut.id }]);
    expect(res.body.data.breakdown.itemsSubtotalMinor).toBe('8000');
  });

  it('flags an archived item as unavailable', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, 'Discontinued', '5000');
    await mutate(ctx, 'delete', `/api/v1/restaurant/menu/items/${item.id}`, owner.cookie).expect(
      200,
    );

    const res = await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.id, quantity: 1, unitPriceMinorAtAdd: '5000' }],
      })
      .expect(200);

    expect(res.body.data.issues).toEqual([{ code: 'ITEM_UNAVAILABLE', itemId: item.id }]);
  });

  it('flags a price change with old and new prices, without silently repricing (BR-20)', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, 'Masala Dosa', '12000');
    await mutate(ctx, 'patch', `/api/v1/restaurant/menu/items/${item.id}`, owner.cookie)
      .send({ priceMinor: '15000' })
      .expect(200);

    const res = await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.id, quantity: 1, unitPriceMinorAtAdd: '12000' }],
      })
      .expect(200);

    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.issues).toEqual([
      { code: 'PRICE_CHANGED', itemId: item.id, oldPriceMinor: '12000', newPriceMinor: '15000' },
    ]);
    // The stale price is never used — the item is excluded from the breakdown entirely.
    expect(res.body.data.breakdown.itemsSubtotalMinor).toBe('0');
  });

  it('flags a cart below the configured minimum order amount (BR-22)', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner, { minOrderAmountMinor: 50000 });
    const item = await createItem(owner, categoryId, 'Idli', '8000');

    const res = await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.id, quantity: 1, unitPriceMinorAtAdd: '8000' }],
      })
      .expect(200);

    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.issues).toEqual([
      { code: 'BELOW_MINIMUM_ORDER', minimumMinor: '50000', subtotalMinor: '8000' },
    ]);
  });

  it('flags a restaurant that is not currently accepting orders, while still returning a breakdown', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, restaurantId, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, 'Idli', '8000');
    const row = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    row.status = 'SUSPENDED';

    const res = await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.id, quantity: 1, unitPriceMinorAtAdd: '8000' }],
      })
      .expect(200);

    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.issues).toEqual([{ code: 'RESTAURANT_UNAVAILABLE', reason: 'SUSPENDED' }]);
    expect(res.body.data.breakdown.itemsSubtotalMinor).toBe('8000');
  });

  it('applies the platform fee from PLATFORM_FEE_BPS', async () => {
    ctx = await createTestApp({ PLATFORM_FEE_BPS: 250 }); // 2.5%
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, 'Idli', '10000');

    const res = await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.id, quantity: 1, unitPriceMinorAtAdd: '10000' }],
      })
      .expect(200);

    expect(res.body.data.breakdown.platformFeeMinor).toBe('250');
    expect(res.body.data.breakdown.payableTotalMinor).toBe('10250');
  });

  it('404s for a nonexistent restaurant slug', async () => {
    ctx = await createTestApp();
    await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: 'does-not-exist',
        items: [
          {
            itemId: '00000000-0000-0000-0000-000000000000',
            quantity: 1,
            unitPriceMinorAtAdd: '100',
          },
        ],
      })
      .expect(404);
  });

  it('rejects an empty items array (422)', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug } = await setUpRestaurant(owner);

    await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({ restaurantSlug: slug, items: [] })
      .expect(422);
  });

  it('rejects a quantity over the cap (422)', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, 'Idli', '8000');

    await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.id, quantity: 100, unitPriceMinorAtAdd: '8000' }],
      })
      .expect(422);
  });

  it('does not require an authenticated session — quote is a public endpoint', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, 'Idli', '8000');

    // No session cookie sent at all — mutate() with no cookie argument
    // still carries the CSRF cookie/header pair, but nothing else.
    await mutate(ctx, 'post', '/api/v1/public/checkout/quote')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.id, quantity: 1, unitPriceMinorAtAdd: '8000' }],
      })
      .expect(200);
  });
});
