import { randomUUID } from 'node:crypto';
import type { AdminRole } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { mutate, get, registerAndLogin, type RegisteredUser } from './support/register-and-login.js';
import { OutboxService } from '../src/platform/outbox/outbox.service.js';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/**
 * Guest complaint path (`PublicSupportController`) — the spec's own
 * acceptance criteria: a guest checkout order (no account, no login) can
 * still file and follow up on a support case via its tracking-link token,
 * exactly parallel to `me-support.controller.ts`'s authenticated flow.
 */
describe('Guest order complaint path (public/orders/:orderNumber/support-cases, e2e)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  async function setUpRestaurant(owner: RegisteredUser) {
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

    const category = await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', owner.cookie)
      .send({ name: 'Mains' })
      .expect(201);

    return { slug, categoryId: category.body.data.id as string };
  }

  async function createItem(owner: RegisteredUser, categoryId: string, priceMinor: string) {
    const res = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
      .send({ categoryId, name: 'Butter Chicken', priceMinor })
      .expect(201);
    return res.body.data as { id: string; priceMinor: string };
  }

  async function fullSetup(itemPriceMinor = '50000') {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, itemPriceMinor);
    return { owner, slug, item };
  }

  async function openCart(slug: string, itemId: string, priceMinor: string) {
    const res = await mutate(ctx, 'post', '/api/v1/public/carts')
      .send({ restaurantSlug: slug, items: [{ itemId, quantity: 1, unitPriceMinorAtAdd: priceMinor }] })
      .expect(201);
    return { cartId: res.body.data.cartId as string, guestToken: res.body.data.guestToken as string };
  }

  /** Checkout only — leaves the order in `PENDING_PAYMENT`, for the "can't complain before payment" test. */
  async function checkout(cartId: string, guestToken: string, phone: string) {
    const res = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId,
        guestToken,
        customer: { name: 'Guest Customer', phone },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
      })
      .expect(200);
    return { orderNumber: res.body.data.orderNumber as string, accessToken: res.body.data.accessToken as string };
  }

  async function placeAndPayOrder(cartId: string, guestToken: string, phone: string) {
    const { orderNumber, accessToken } = await checkout(cartId, guestToken, phone);
    const simulateRes = await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/simulate-payment`)
      .send({ token: accessToken, outcome: 'CAPTURED' })
      .expect(200);
    await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/verify-payment`)
      .send({ token: accessToken, providerPaymentId: simulateRes.body.data.providerPaymentId })
      .expect(200);
    await ctx.app.get(OutboxService).relayPending();
    return { orderNumber, accessToken };
  }

  it('a guest files a complaint, reads it back, and posts a follow-up message with an attachment, with no account', async () => {
    const { slug, item } = await fullSetup();
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber, accessToken } = await placeAndPayOrder(cartId, guestToken, '+919876530001');

    const created = await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/support-cases`)
      .send({ token: accessToken, category: 'DELIVERY', subject: 'Order is late', description: 'Still waiting.' })
      .expect(201);
    expect(created.body.data.status).toBe('OPEN');
    const caseId = created.body.data.id as string;

    const listed = await get(ctx, `/api/v1/public/orders/${orderNumber}/support-cases?token=${accessToken}`).expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].id).toBe(caseId);

    const detail = await get(ctx, `/api/v1/public/orders/${orderNumber}/support-cases/${caseId}?token=${accessToken}`).expect(200);
    expect(detail.body.data.messages).toEqual([]);

    const presign = await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/support-cases/${caseId}/attachments/presign`)
      .send({ token: accessToken, contentType: 'image/jpeg', sizeBytes: JPEG_BYTES.length })
      .expect(200);
    ctx.storage.seed(presign.body.data.key, JPEG_BYTES);

    await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/support-cases/${caseId}/messages`)
      .send({
        token: accessToken,
        body: 'Photo of the wrong item',
        attachments: [{ key: presign.body.data.key, filename: 'wrong-item.jpg', contentType: 'image/jpeg', sizeBytes: JPEG_BYTES.length }],
      })
      .expect(201);

    const detailAfterReply = await get(ctx, `/api/v1/public/orders/${orderNumber}/support-cases/${caseId}?token=${accessToken}`).expect(200);
    expect(detailAfterReply.body.data.messages).toHaveLength(1);
    expect(detailAfterReply.body.data.status).toBe('OPEN');

    const attachment = ctx.db.supportAttachments.find((a) => a.caseId === caseId)!;
    const download = await get(
      ctx,
      `/api/v1/public/orders/${orderNumber}/support-cases/${caseId}/attachments/${attachment.id}?token=${accessToken}`,
    ).expect(200);
    expect(download.body.data.url).toContain(presign.body.data.key);
  });

  it('a missing or wrong token 404s on every endpoint, never distinguishing "wrong token" from "no such order"', async () => {
    const { slug, item } = await fullSetup();
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber } = await placeAndPayOrder(cartId, guestToken, '+919876530002');

    await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/support-cases`)
      .send({ token: 'not-the-real-token', category: 'OTHER', subject: 'x', description: 'y' })
      .expect(404);
    await get(ctx, `/api/v1/public/orders/${orderNumber}/support-cases`).expect(404);
    await get(ctx, `/api/v1/public/orders/DO-NONEXISTENT-0000/support-cases?token=whatever`).expect(404);
  });

  it('an order still awaiting payment cannot have a complaint filed against it', async () => {
    const { slug, item } = await fullSetup();
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber, accessToken } = await checkout(cartId, guestToken, '+919876530003');

    await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/support-cases`)
      .send({ token: accessToken, category: 'PAYMENT', subject: 'x', description: 'y' })
      .expect(422);
  });

  it("a token valid for one order can never reach a different order's case, even by guessed id", async () => {
    const { slug, item } = await fullSetup();

    const orderA = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber: orderNumberA, accessToken: tokenA } = await placeAndPayOrder(
      orderA.cartId,
      orderA.guestToken,
      '+919876530004',
    );
    const caseA = await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumberA}/support-cases`)
      .send({ token: tokenA, category: 'ORDER', subject: 'Case A', description: 'x' })
      .expect(201);
    const caseAId = caseA.body.data.id as string;

    const orderB = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber: orderNumberB, accessToken: tokenB } = await placeAndPayOrder(
      orderB.cartId,
      orderB.guestToken,
      '+919876530005',
    );

    // orderB's own token is valid, but case A doesn't belong to orderB — 404, not 403.
    await get(ctx, `/api/v1/public/orders/${orderNumberB}/support-cases/${caseAId}?token=${tokenB}`).expect(404);
    // Even orderA's own number with orderB's token fails — the token must match orderA specifically.
    await get(ctx, `/api/v1/public/orders/${orderNumberA}/support-cases/${caseAId}?token=${tokenB}`).expect(404);
  });

  it('case creation is rate limited per the same defense-in-depth as auth endpoints', async () => {
    const { slug, item } = await fullSetup();
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber, accessToken } = await placeAndPayOrder(cartId, guestToken, '+919876530006');

    const responses = [];
    for (let i = 0; i < 6; i++) {
      responses.push(
        await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/support-cases`).send({
          token: accessToken,
          category: 'OTHER',
          subject: `Attempt ${i}`,
          description: 'x',
        }),
      );
    }
    const last = responses.at(-1);
    expect(last?.status).toBe(429);
    expect(last?.headers['retry-after']).toBeTruthy();
  });

  /** Same lightweight shortcut `support-analytics.e2e.test.ts` established — sets `mfaVerifiedAt` directly rather than driving the real MFA-enrollment HTTP flow. */
  async function seedAdmin(role: AdminRole) {
    const admin = await registerAndLogin(ctx, { email: `${role.toLowerCase()}-${randomUUID()}@direct-order.test` });
    const adminUserId = randomUUID();
    ctx.db.adminUsers.push({
      id: adminUserId,
      userId: admin.userId,
      role,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const session = ctx.db.sessions.find((s) => s.userId === admin.userId)!;
    session.mfaVerifiedAt = new Date();
    const user = ctx.db.users.find((u) => u.id === admin.userId)!;
    user.mfaEnabledAt = new Date();
    return { ...admin, adminUserId };
  }

  it('an admin support agent sees a guest-filed case in the same queue as any other case, and can reply to it', async () => {
    const { slug, item } = await fullSetup();
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const { orderNumber, accessToken } = await placeAndPayOrder(cartId, guestToken, '+919876530007');

    const created = await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/support-cases`)
      .send({ token: accessToken, category: 'RESTAURANT', subject: 'Missing item', description: 'No raita.' })
      .expect(201);
    const caseId = created.body.data.id as string;

    const admin = await seedAdmin('SUPPORT');
    const list = await get(ctx, '/api/v1/admin/support/cases', admin.cookie).expect(200);
    expect(list.body.data.map((c: { id: string }) => c.id)).toContain(caseId);

    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/messages`, admin.cookie)
      .send({ body: 'Sorry about that, refunding the item.' })
      .expect(201);

    const guestView = await get(ctx, `/api/v1/public/orders/${orderNumber}/support-cases/${caseId}?token=${accessToken}`).expect(200);
    expect(guestView.body.data.messages).toHaveLength(1);
    expect(guestView.body.data.messages[0].body).toBe('Sorry about that, refunding the item.');
    expect(guestView.body.data.status).toBe('WAITING_CUSTOMER');
  });
});
