import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { RestaurantStaff, User } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AuthorizationGuard } from '../src/platform/authorization/authorization.guard.js';
import type { RestaurantMembershipRepository } from '../src/platform/authorization/restaurant-membership.repository.js';
import { PERMISSIONS_KEY } from '../src/platform/authorization/permissions.decorator.js';
import { TENANT_SCOPED_KEY } from '../src/platform/authorization/tenant-scoped.decorator.js';
import type { AuthenticatedRequest } from '../src/modules/identity/guards/auth.guard.js';
import { ForbiddenError, UnauthenticatedError } from '../src/platform/errors/app-error.js';
import type { AuditService } from '../src/platform/audit/audit.service.js';

const USER_ID = 'user-1';
const RESTAURANT_A = '11111111-1111-1111-1111-111111111111';
const RESTAURANT_B = '22222222-2222-2222-2222-222222222222';

function fakeUser(): User {
  return { id: USER_ID } as User;
}

function fakeMembership(overrides: Partial<RestaurantStaff> = {}): RestaurantStaff {
  return {
    id: 'staff-1',
    userId: USER_ID,
    restaurantId: RESTAURANT_A,
    role: 'STAFF',
    status: 'ACTIVE',
    ...overrides,
  } as RestaurantStaff;
}

function createContext(request: Partial<AuthenticatedRequest>): ExecutionContext {
  // Mutates defaults onto the SAME object reference the caller passed in
  // (rather than spreading into a copy) so a test can inspect
  // `request.tenant` after canActivate() runs and see the guard's mutation.
  if (!('headers' in request)) {
    (request as AuthenticatedRequest).headers = {};
  }
  return {
    getHandler: () => function handler() {},
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function createReflector(metadata: { tenantScoped?: boolean; permissions?: string[] }): Reflector {
  return {
    get: (key: string) => {
      if (key === TENANT_SCOPED_KEY) return metadata.tenantScoped;
      if (key === PERMISSIONS_KEY) return metadata.permissions;
      return undefined;
    },
  } as unknown as Reflector;
}

function createHarness(metadata: { tenantScoped?: boolean; permissions?: string[] }) {
  const memberships = {
    findActiveByUser: vi.fn(),
    find: vi.fn(),
  } as unknown as RestaurantMembershipRepository;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const guard = new AuthorizationGuard(createReflector(metadata), memberships, audit);
  return { guard, memberships, audit };
}

describe('AuthorizationGuard', () => {
  it('passes routes with neither @TenantScoped() nor @Permissions() straight through, without touching the request at all', async () => {
    const { guard, memberships } = createHarness({});
    await expect(guard.canActivate(createContext({}))).resolves.toBe(true);
    expect(memberships.findActiveByUser).not.toHaveBeenCalled();
  });

  it('throws UnauthenticatedError if request.user is unset (AuthGuard did not run first)', async () => {
    const { guard } = createHarness({ tenantScoped: true });
    await expect(guard.canActivate(createContext({ user: undefined }))).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('@Permissions() without @TenantScoped() always denies — no admin principal type exists yet', async () => {
    const { guard } = createHarness({ permissions: ['audit:read'] });
    await expect(guard.canActivate(createContext({ user: fakeUser() }))).rejects.toThrow(
      ForbiddenError,
    );
  });

  describe('tenant resolution — no X-Restaurant-Id header', () => {
    it('resolves the sole active membership implicitly', async () => {
      const { guard, memberships } = createHarness({ tenantScoped: true });
      const membership = fakeMembership();
      (memberships.findActiveByUser as ReturnType<typeof vi.fn>).mockResolvedValue([membership]);

      const request = { user: fakeUser(), headers: {} } as AuthenticatedRequest;
      await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
      expect((request as unknown as { tenant: { restaurantId: string } }).tenant).toEqual({
        restaurantId: RESTAURANT_A,
        staffId: 'staff-1',
        role: 'STAFF',
      });
    });

    it('denies when the user has zero active memberships', async () => {
      const { guard, memberships } = createHarness({ tenantScoped: true });
      (memberships.findActiveByUser as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await expect(guard.canActivate(createContext({ user: fakeUser() }))).rejects.toThrow(
        ForbiddenError,
      );
    });

    it('denies (ambiguous) when the user has more than one active membership and sent no header', async () => {
      const { guard, memberships } = createHarness({ tenantScoped: true });
      (memberships.findActiveByUser as ReturnType<typeof vi.fn>).mockResolvedValue([
        fakeMembership({ restaurantId: RESTAURANT_A }),
        fakeMembership({ restaurantId: RESTAURANT_B }),
      ]);
      await expect(guard.canActivate(createContext({ user: fakeUser() }))).rejects.toThrow(
        ForbiddenError,
      );
    });
  });

  describe('tenant resolution — with X-Restaurant-Id header (docs/05 §9.4)', () => {
    it('resolves the tenant when the header matches an ACTIVE membership', async () => {
      const { guard, memberships } = createHarness({ tenantScoped: true });
      (memberships.find as ReturnType<typeof vi.fn>).mockResolvedValue(fakeMembership());

      const request = {
        user: fakeUser(),
        headers: { 'x-restaurant-id': RESTAURANT_A },
      } as unknown as AuthenticatedRequest;
      await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
      expect(memberships.find).toHaveBeenCalledWith(USER_ID, RESTAURANT_A);
    });

    it('denies with 403 and logs a tenant-isolation audit event when the user has no membership for that restaurant', async () => {
      const { guard, memberships, audit } = createHarness({ tenantScoped: true });
      (memberships.find as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const request = {
        user: fakeUser(),
        headers: { 'x-restaurant-id': RESTAURANT_B },
      } as unknown as AuthenticatedRequest;
      await expect(guard.canActivate(createContext(request))).rejects.toThrow(ForbiddenError);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'TENANT_ISOLATION_VIOLATION', actorId: USER_ID }),
      );
    });

    it('denies a DISABLED membership the same as no membership at all (disabled staff loses access immediately)', async () => {
      const { guard, memberships, audit } = createHarness({ tenantScoped: true });
      (memberships.find as ReturnType<typeof vi.fn>).mockResolvedValue(
        fakeMembership({ status: 'DISABLED' }),
      );

      const request = {
        user: fakeUser(),
        headers: { 'x-restaurant-id': RESTAURANT_A },
      } as unknown as AuthenticatedRequest;
      await expect(guard.canActivate(createContext(request))).rejects.toThrow(ForbiddenError);
      expect(audit.record).toHaveBeenCalled();
    });

    it('rejects a malformed (non-UUID) header value without ever querying the database', async () => {
      const { guard, memberships } = createHarness({ tenantScoped: true });
      const request = {
        user: fakeUser(),
        headers: { 'x-restaurant-id': 'not-a-uuid; DROP TABLE restaurants;' },
      } as unknown as AuthenticatedRequest;
      await expect(guard.canActivate(createContext(request))).rejects.toThrow(ForbiddenError);
      expect(memberships.find).not.toHaveBeenCalled();
    });
  });

  describe('permission checks', () => {
    it('allows when the resolved role holds every required permission', async () => {
      const { guard, memberships } = createHarness({
        tenantScoped: true,
        permissions: ['menu:read'],
      });
      (memberships.findActiveByUser as ReturnType<typeof vi.fn>).mockResolvedValue([
        fakeMembership({ role: 'STAFF' }),
      ]);
      await expect(guard.canActivate(createContext({ user: fakeUser() }))).resolves.toBe(true);
    });

    it('denies when the resolved role lacks a required permission (STAFF cannot menu:write)', async () => {
      const { guard, memberships } = createHarness({
        tenantScoped: true,
        permissions: ['menu:write'],
      });
      (memberships.findActiveByUser as ReturnType<typeof vi.fn>).mockResolvedValue([
        fakeMembership({ role: 'STAFF' }),
      ]);
      await expect(guard.canActivate(createContext({ user: fakeUser() }))).rejects.toThrow(
        ForbiddenError,
      );
    });

    it('requires ALL listed permissions, not just one', async () => {
      const { guard, memberships } = createHarness({
        tenantScoped: true,
        permissions: ['menu:read', 'menu:write'],
      });
      (memberships.findActiveByUser as ReturnType<typeof vi.fn>).mockResolvedValue([
        fakeMembership({ role: 'STAFF' }), // has menu:read, not menu:write
      ]);
      await expect(guard.canActivate(createContext({ user: fakeUser() }))).rejects.toThrow(
        ForbiddenError,
      );
    });

    it('STAFF calling a MANAGER-only permission is denied — restaurant role ordering is enforced', async () => {
      const { guard, memberships } = createHarness({
        tenantScoped: true,
        permissions: ['staff:invite'],
      });
      (memberships.findActiveByUser as ReturnType<typeof vi.fn>).mockResolvedValue([
        fakeMembership({ role: 'STAFF' }),
      ]);
      await expect(guard.canActivate(createContext({ user: fakeUser() }))).rejects.toThrow(
        ForbiddenError,
      );
    });

    it('OWNER holds everything STAFF and MANAGER hold (role ordering)', async () => {
      const { guard, memberships } = createHarness({
        tenantScoped: true,
        permissions: ['staff:invite'],
      });
      (memberships.findActiveByUser as ReturnType<typeof vi.fn>).mockResolvedValue([
        fakeMembership({ role: 'OWNER' }),
      ]);
      await expect(guard.canActivate(createContext({ user: fakeUser() }))).resolves.toBe(true);
    });
  });
});
