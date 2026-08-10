import { randomUUID } from 'node:crypto';
import { Controller, Get, Inject, Module, Param, UseGuards } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthGuard } from '../src/modules/identity/guards/auth.guard.js';
import { IdentityModule } from '../src/modules/identity/identity.module.js';
import { RestaurantStaffRepository } from '../src/modules/restaurants/repositories/restaurant-staff.repository.js';
import { AuthorizationGuard } from '../src/platform/authorization/authorization.guard.js';
import { CurrentTenant } from '../src/platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../src/platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../src/platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../src/platform/authorization/tenant-context.js';
import { AuditService } from '../src/platform/audit/audit.service.js';
import { NotFoundError } from '../src/platform/errors/app-error.js';
import { assertTenantResourceFound } from '../src/platform/authorization/tenant-resource.js';
import { ok } from '../src/platform/http/response-envelope.js';
import { createTestApp, type TestApp } from './support/create-test-app.js';

/**
 * A test-only controller exercising AuthorizationGuard exactly the way
 * a real Phase 5+ controller will: `@UseGuards(AuthGuard,
 * AuthorizationGuard)` at the controller level, `@TenantScoped()` /
 * `@Permissions(...)` per route. No real business endpoint uses these
 * guards yet (Phase 4 is infrastructure — see the phase report), so
 * this is how "the parameterised tenant-isolation test suite" proves
 * the guards work over real HTTP before anything depends on them.
 */
@Controller('test-tenant')
@UseGuards(AuthGuard, AuthorizationGuard)
class TenantProbeController {
  constructor(
    @Inject(RestaurantStaffRepository) private readonly staff: RestaurantStaffRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('read')
  @TenantScoped()
  @Permissions('restaurant:read')
  read(@CurrentTenant() tenant: TenantContext) {
    return ok(tenant);
  }

  @Get('menu-write')
  @TenantScoped()
  @Permissions('menu:write')
  menuWrite(@CurrentTenant() tenant: TenantContext) {
    return ok(tenant);
  }

  @Get('staff/:id')
  @TenantScoped()
  @Permissions('staff:read')
  async staffById(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    const row = await this.staff.findById(tenant.restaurantId, id);
    const found = await assertTenantResourceFound(row, {
      audit: this.audit,
      actorId: tenant.staffId,
      restaurantId: tenant.restaurantId,
      entityType: 'RestaurantStaff',
      entityId: id,
    });
    if (!found) throw new NotFoundError(); // unreachable, narrows the type for TS
    return ok(found);
  }
}

@Module({
  imports: [IdentityModule],
  controllers: [TenantProbeController],
  providers: [RestaurantStaffRepository],
})
class TenantProbeModule {}

describe('Authorization (Phase 4, e2e)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp({}, [TenantProbeModule]);
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  const OWNER = {
    email: 'owner@spiceroute.test',
    fullName: 'Priya Owner',
    password: 'correct-horse-battery-staple',
  };

  async function registerVerifyLogin(overrides: Partial<typeof OWNER> = {}) {
    const input = { ...OWNER, ...overrides };
    await request(ctx.app.getHttpServer()).post('/api/v1/auth/register').send(input).expect(200);
    const code = ctx.notifier.emailVerificationCodes.get(input.email)!;
    await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/otp/verify')
      .send({ identifier: input.email, purpose: 'EMAIL_VERIFICATION', code })
      .expect(200);
    const loginRes = await request(ctx.app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: input.email, password: input.password })
      .expect(200);

    const userId = ctx.db.users.find((u) => u.email === input.email)!.id;
    const raw = loginRes.headers['set-cookie'] as string[] | string | undefined;
    const cookie = (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map((c) => c.split(';')[0])
      .join('; ');
    return { userId, cookie };
  }

  function seedRestaurant(): string {
    const id = randomUUID();
    ctx.db.restaurants.push({
      id,
      slug: `restaurant-${id.slice(0, 8)}`,
      name: 'Spice Route',
      status: 'ACTIVE',
      onboardingStatus: 'COMPLETED',
      orderingEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  function seedMembership(
    userId: string,
    restaurantId: string,
    role: 'STAFF' | 'MANAGER' | 'OWNER' = 'STAFF',
    status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
  ): string {
    const id = randomUUID();
    ctx.db.restaurantStaff.push({
      id,
      userId,
      restaurantId,
      role,
      status,
      joinedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  it('401 with no session cookie at all', async () => {
    await request(ctx.app.getHttpServer()).get('/api/v1/test-tenant/read').expect(401);
  });

  it('403 when the user has no restaurant membership at all', async () => {
    const { cookie } = await registerVerifyLogin();
    await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/read')
      .set('Cookie', cookie)
      .expect(403);
  });

  it('resolves the sole active membership implicitly (no X-Restaurant-Id needed) and returns 200', async () => {
    const { userId, cookie } = await registerVerifyLogin();
    const restaurantId = seedRestaurant();
    seedMembership(userId, restaurantId, 'STAFF');

    const res = await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/read')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.data.restaurantId).toBe(restaurantId);
    expect(res.body.data.role).toBe('STAFF');
  });

  it('a user belonging to two restaurants must disambiguate with X-Restaurant-Id — omitting it is 403', async () => {
    const { userId, cookie } = await registerVerifyLogin();
    const restaurantA = seedRestaurant();
    const restaurantB = seedRestaurant();
    seedMembership(userId, restaurantA, 'STAFF');
    seedMembership(userId, restaurantB, 'MANAGER');

    await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/read')
      .set('Cookie', cookie)
      .expect(403);

    const resA = await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/read')
      .set('Cookie', cookie)
      .set('X-Restaurant-Id', restaurantA)
      .expect(200);
    expect(resA.body.data.restaurantId).toBe(restaurantA);

    const resB = await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/read')
      .set('Cookie', cookie)
      .set('X-Restaurant-Id', restaurantB)
      .expect(200);
    expect(resB.body.data.restaurantId).toBe(restaurantB);
  });

  it('X-Restaurant-Id for a restaurant the user does not belong to returns 403 and logs a tenant-isolation event (docs/05 §9.4)', async () => {
    const { userId, cookie } = await registerVerifyLogin();
    const ownRestaurant = seedRestaurant();
    const otherRestaurant = seedRestaurant();
    seedMembership(userId, ownRestaurant, 'OWNER');

    await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/read')
      .set('Cookie', cookie)
      .set('X-Restaurant-Id', otherRestaurant)
      .expect(403);

    expect(
      ctx.db.auditLogs.some(
        (entry) =>
          entry.action === 'TENANT_ISOLATION_VIOLATION' && entry.entityId === otherRestaurant,
      ),
    ).toBe(true);
  });

  it('a resource belonging to a different restaurant than the resolved tenant returns 404, not 403 or the resource, and logs a tenant-isolation event (docs/04 §8.1)', async () => {
    const { userId, cookie } = await registerVerifyLogin();
    const ownRestaurant = seedRestaurant();
    const otherRestaurant = seedRestaurant();
    seedMembership(userId, ownRestaurant, 'OWNER');
    const otherUserId = randomUUID();
    const foreignStaffId = seedMembership(otherUserId, otherRestaurant, 'STAFF');

    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/test-tenant/staff/${foreignStaffId}`)
      .set('Cookie', cookie)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');

    expect(
      ctx.db.auditLogs.some(
        (entry) =>
          entry.action === 'TENANT_ISOLATION_VIOLATION' && entry.entityId === foreignStaffId,
      ),
    ).toBe(true);
  });

  it('a resource within the resolved tenant is returned normally', async () => {
    const { userId, cookie } = await registerVerifyLogin();
    const restaurantId = seedRestaurant();
    seedMembership(userId, restaurantId, 'OWNER');
    const colleagueStaffId = seedMembership(randomUUID(), restaurantId, 'STAFF');

    const res = await request(ctx.app.getHttpServer())
      .get(`/api/v1/test-tenant/staff/${colleagueStaffId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.data.id).toBe(colleagueStaffId);
  });

  it('STAFF calling a MANAGER-only permission is denied — role capability is enforced, not just tenant membership', async () => {
    const { userId, cookie } = await registerVerifyLogin();
    const restaurantId = seedRestaurant();
    seedMembership(userId, restaurantId, 'STAFF');

    await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/menu-write')
      .set('Cookie', cookie)
      .expect(403);
  });

  it('MANAGER (and OWNER) can call the same MANAGER-only permission — restaurant role ordering', async () => {
    const { userId, cookie } = await registerVerifyLogin();
    const restaurantId = seedRestaurant();
    seedMembership(userId, restaurantId, 'MANAGER');

    await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/menu-write')
      .set('Cookie', cookie)
      .expect(200);
  });

  it('a staff member disabled mid-session loses access on the very next request (docs/05 §9.4, Phase 4 acceptance criteria)', async () => {
    const { userId, cookie } = await registerVerifyLogin();
    const restaurantId = seedRestaurant();
    seedMembership(userId, restaurantId, 'STAFF');

    await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/read')
      .set('Cookie', cookie)
      .expect(200);

    const membership = ctx.db.restaurantStaff.find(
      (s) => s.userId === userId && s.restaurantId === restaurantId,
    )!;
    membership.status = 'DISABLED';

    await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/read')
      .set('Cookie', cookie)
      .expect(403);
  });

  it('rejects a malformed X-Restaurant-Id header (not a UUID) with 403 rather than a 500', async () => {
    const { cookie } = await registerVerifyLogin();
    await request(ctx.app.getHttpServer())
      .get('/api/v1/test-tenant/read')
      .set('Cookie', cookie)
      .set('X-Restaurant-Id', 'garbage-not-a-uuid')
      .expect(403);
  });
});
