import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminRole } from '@prisma/client';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import {
  get,
  mutate,
  registerAndLogin,
  type RegisteredUser,
} from './support/register-and-login.js';
import { TotpService } from '../src/modules/identity/services/totp.service.js';

/**
 * Phase 22 — the admin-side menu CRUD surface
 * (`/admin/restaurants/:restaurantId/menu/*`). Reuses
 * MenuCategoryService/MenuItemService verbatim (same as the owner-side
 * controllers) — this file's job is proving the NEW authorization
 * surface, not re-testing menu business logic already covered by
 * menu.e2e.test.ts.
 */
describe('Admin-side menu management (Phase 22, e2e)', () => {
  let ctx: TestApp;
  const totp = new TotpService();

  afterEach(async () => {
    await ctx.app.close();
  });

  interface AdminPrincipal extends RegisteredUser {
    adminUserId: string;
    role: AdminRole;
  }

  async function registerAdmin(role: AdminRole, email?: string): Promise<AdminPrincipal> {
    const owner = await registerAndLogin(ctx, {
      email: email ?? `admin-${randomUUID()}@direct-order.test`,
    });
    const adminUserId = randomUUID();
    ctx.db.adminUsers.push({
      id: adminUserId,
      userId: owner.userId,
      role,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const enrollRes = await mutate(ctx, 'post', '/api/v1/auth/mfa/enroll', owner.cookie)
      .send({})
      .expect(200);
    const secret = enrollRes.body.data.secret as string;
    const code = totp.generate(secret);
    await mutate(ctx, 'post', '/api/v1/auth/mfa/enroll/confirm', owner.cookie)
      .send({ code })
      .expect(200);

    return { ...owner, adminUserId, role };
  }

  async function createAdminRestaurant(admin: AdminPrincipal, name = 'Fresh Kitchen') {
    const res = await mutate(ctx, 'post', '/api/v1/admin/restaurants', admin.cookie)
      .send({ name })
      .expect(201);
    return { id: res.body.data.id as string, slug: res.body.data.slug as string };
  }

  it('admin can create a category and item; both persist and are audited as ADMIN', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { id: restaurantId } = await createAdminRestaurant(admin);

    const categoryRes = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/menu/categories`,
      admin.cookie,
    )
      .send({ name: 'Mains' })
      .expect(201);
    const categoryId = categoryRes.body.data.id as string;

    const itemRes = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/menu/items`,
      admin.cookie,
    )
      .send({ categoryId, name: 'Andhra Thali', priceMinor: '25000', dietaryTag: 'VEG' })
      .expect(201);
    expect(itemRes.body.data.priceMinor).toBe('25000');

    const listRes = await get(
      ctx,
      `/api/v1/admin/restaurants/${restaurantId}/menu/items`,
      admin.cookie,
    ).expect(200);
    expect(listRes.body.data).toHaveLength(1);

    const categoryAudit = ctx.db.auditLogs.find(
      (a) => a.action === 'MENU_CATEGORY_CREATED' && a.entityId === categoryId,
    );
    expect(categoryAudit!.actorType).toBe('ADMIN');
    expect(categoryAudit!.actorId).toBe(admin.adminUserId);
    const itemAudit = ctx.db.auditLogs.find(
      (a) => a.action === 'MENU_ITEM_CREATED' && a.entityId === itemRes.body.data.id,
    );
    expect(itemAudit!.actorType).toBe('ADMIN');
  });

  it('admin can update, toggle availability on, reorder, and archive menu content', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { id: restaurantId } = await createAdminRestaurant(admin);
    const category = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/menu/categories`,
      admin.cookie,
    )
      .send({ name: 'Mains' })
      .expect(201);
    const item = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/menu/items`,
      admin.cookie,
    )
      .send({ categoryId: category.body.data.id, name: 'Thali', priceMinor: '20000' })
      .expect(201);

    await mutate(
      ctx,
      'patch',
      `/api/v1/admin/restaurants/${restaurantId}/menu/items/${item.body.data.id}`,
      admin.cookie,
    )
      .send({ priceMinor: '22000' })
      .expect(200);

    await mutate(
      ctx,
      'patch',
      `/api/v1/admin/restaurants/${restaurantId}/menu/items/${item.body.data.id}/availability`,
      admin.cookie,
    )
      .send({ isAvailable: false })
      .expect(200);

    await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/menu/categories/reorder`,
      admin.cookie,
    )
      .send({ items: [{ id: category.body.data.id, displayOrder: 0 }] })
      .expect(200);

    await mutate(
      ctx,
      'delete',
      `/api/v1/admin/restaurants/${restaurantId}/menu/items/${item.body.data.id}`,
      admin.cookie,
    ).expect(200);

    const finalList = await get(
      ctx,
      `/api/v1/admin/restaurants/${restaurantId}/menu/items`,
      admin.cookie,
    ).expect(200);
    expect(finalList.body.data).toHaveLength(0); // archived items are excluded from the default list
  });

  // ── Authorization: the subtly-important cases ────────────────────────

  it('restaurant STAFF/MANAGER/OWNER (real membership, no AdminUser row) get 403 on the admin menu routes, even for their OWN restaurant', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Owner Kitchen' })
      .expect(201);
    const restaurantId = created.body.data.id as string;

    await get(
      ctx,
      `/api/v1/admin/restaurants/${restaurantId}/menu/categories`,
      owner.cookie,
    ).expect(403);
    await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/menu/categories`,
      owner.cookie,
    )
      .send({ name: 'Mains' })
      .expect(403);
  });

  it('an ADMIN_OPERATIONS admin (now holding menu:write via the Phase 22 matrix change) CAN reach the new admin menu route', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { id: restaurantId } = await createAdminRestaurant(admin);

    await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/menu/categories`,
      admin.cookie,
    )
      .send({ name: 'Mains' })
      .expect(201);
  });

  it('that SAME ADMIN_OPERATIONS admin CANNOT reach the owner-side tenant-scoped /restaurant/menu/* routes — no RestaurantStaff membership, despite holding menu:write', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    void (await createAdminRestaurant(admin)); // proves the admin genuinely holds menu:write (previous test) before checking the tenant-scoped side is still closed

    await get(ctx, '/api/v1/restaurant/menu/categories', admin.cookie).expect(403);
    await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', admin.cookie)
      .send({ name: 'Mains' })
      .expect(403);
  });

  it('an admin without menu:write (SUPPORT — read-only) can list but not create/edit menu content', async () => {
    ctx = await createTestApp();
    const opsAdmin = await registerAdmin(
      'ADMIN_OPERATIONS',
      `ops-${randomUUID()}@direct-order.test`,
    );
    const support = await registerAdmin('SUPPORT');
    const { id: restaurantId } = await createAdminRestaurant(opsAdmin);

    await get(
      ctx,
      `/api/v1/admin/restaurants/${restaurantId}/menu/categories`,
      support.cookie,
    ).expect(200);
    await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/menu/categories`,
      support.cookie,
    )
      .send({ name: 'Mains' })
      .expect(403);
  });

  // ── Storefront visibility gate ────────────────────────────────────────

  it('an admin-entered menu item is invisible on the public storefront until the restaurant is ACTIVE, regardless of who entered it', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { id: restaurantId, slug } = await createAdminRestaurant(admin);
    const category = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/menu/categories`,
      admin.cookie,
    )
      .send({ name: 'Mains' })
      .expect(201);
    await mutate(ctx, 'post', `/api/v1/admin/restaurants/${restaurantId}/menu/items`, admin.cookie)
      .send({ categoryId: category.body.data.id, name: 'Thali', priceMinor: '20000' })
      .expect(201);

    // Still DRAFT — the whole restaurant 404s on the public endpoint.
    await get(ctx, `/api/v1/public/restaurants/${slug}`).expect(404);

    // Approve it through the full flow: profile+address, submit, approve.
    await mutate(ctx, 'patch', `/api/v1/admin/restaurants/${restaurantId}/profile`, admin.cookie)
      .send({
        address: {
          line1: '1 MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        },
      })
      .expect(200);
    await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/submit-for-approval`,
      admin.cookie,
    )
      .send({})
      .expect(200);
    await mutate(ctx, 'post', `/api/v1/admin/restaurants/${restaurantId}/approve`, admin.cookie)
      .send({})
      .expect(200);

    const publicMenu = await get(ctx, `/api/v1/public/restaurants/${slug}/menu`).expect(200);
    expect(publicMenu.body.data.categories.some((c: { name: string }) => c.name === 'Mains')).toBe(
      true,
    );
  });
});
