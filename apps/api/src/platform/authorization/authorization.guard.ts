import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RestaurantStaff } from '@prisma/client';
import { ForbiddenError, UnauthenticatedError } from '../errors/app-error.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthenticatedRequest } from '../../modules/identity/guards/auth.guard.js';
import { hasPermission, type Permission } from './permission.catalogue.js';
import { PERMISSIONS_KEY } from './permissions.decorator.js';
import { TENANT_SCOPED_KEY } from './tenant-scoped.decorator.js';
import { RestaurantMembershipRepository } from './restaurant-membership.repository.js';
import { AdminUserRepository } from './admin-user.repository.js';
import type { TenantContext } from './tenant-context.js';
import type { AdminContext } from './admin-context.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads `@TenantScoped()` / `@Permissions(...)` metadata (both absent =
 * this guard has nothing to do, passes straight through — same
 * short-circuit pattern as RateLimitGuard) and enforces the three-part
 * check from docs/05-authorization-matrix.md §9.1: authentication, role
 * capability, resource scope.
 *
 * MUST run after AuthGuard has populated `request.user`. NOT registered
 * globally (see authorization.module.ts) — Nest runs global guards
 * before controller/method-level ones, and AuthGuard is applied
 * per-controller (modules/identity), so a global AuthorizationGuard
 * would run first and never see `request.user`. Every tenant-scoped
 * controller applies both explicitly, in order:
 * `@UseGuards(AuthGuard, AuthorizationGuard)`. If `request.user` is
 * somehow still unset when this guard's metadata check trips, that is
 * a wiring bug in the controller, not a valid "no session" case — it
 * throws UnauthenticatedError rather than silently allowing the
 * request through.
 *
 * Resolves a **restaurant** role (STAFF/MANAGER/OWNER) on
 * `@TenantScoped()` routes, or an **admin** role (SUPPORT/OPS/FINANCE/
 * SUPER_ADMIN, via `admin_users`, Phase 13) on routes that declare
 * `@Permissions(...)` without `@TenantScoped()` — the two branches are
 * mutually exclusive by construction, since no route in this codebase
 * is both tenant-scoped and admin-only. An admin principal additionally
 * MUST have completed MFA for the CURRENT session
 * (`session.mfaVerifiedAt`, checked against the live row `AuthGuard`
 * already fetched this request — never the JWT alone) before any
 * `@Permissions(...)` check is evaluated: docs/01-domain-model.md's
 * AdminUser constraint ("MFA required") is enforced HERE, at the API,
 * not left to the frontend to merely prompt for (docs/14-acceptance-
 * criteria.md, Phase 13: "Admin MFA is enforced at the API, not only in
 * the UI").
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RestaurantMembershipRepository)
    private readonly memberships: RestaurantMembershipRepository,
    @Inject(AdminUserRepository) private readonly adminUsers: AdminUserRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isTenantScoped = this.reflector.get<boolean | undefined>(
      TENANT_SCOPED_KEY,
      context.getHandler(),
    );
    const permissions =
      this.reflector.get<Permission[] | undefined>(PERMISSIONS_KEY, context.getHandler()) ?? [];

    if (!isTenantScoped && permissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthenticatedError();
    }

    if (!isTenantScoped) {
      const admin = await this.resolveAdmin(request);
      (request as AuthenticatedRequest & { admin: AdminContext }).admin = admin;

      if (permissions.length > 0 && !permissions.every((p) => hasPermission(admin.role, p))) {
        throw new ForbiddenError();
      }
      return true;
    }

    const tenant = await this.resolveTenant(request);
    (request as AuthenticatedRequest & { tenant: TenantContext }).tenant = tenant;

    if (permissions.length > 0 && !permissions.every((p) => hasPermission(tenant.role, p))) {
      throw new ForbiddenError();
    }

    return true;
  }

  private async resolveAdmin(request: AuthenticatedRequest): Promise<AdminContext> {
    const userId = request.user!.id;
    const adminUser = await this.adminUsers.findByUserId(userId);
    if (!adminUser || adminUser.status !== 'ACTIVE') {
      throw new ForbiddenError();
    }
    // MFA required for every admin role (docs/01 §5.2's AdminUser
    // constraint), enforced against the LIVE session row, not the JWT —
    // enrollment alone is not enough; THIS session must have verified a
    // code via POST /auth/mfa/verify.
    if (!request.user!.mfaEnabledAt || !request.session?.mfaVerifiedAt) {
      throw new ForbiddenError('MFA verification is required for this session.');
    }
    return { adminUserId: adminUser.id, role: adminUser.role };
  }

  private async resolveTenant(request: AuthenticatedRequest): Promise<TenantContext> {
    const userId = request.user!.id;
    const headerRestaurantId = this.readRestaurantIdHeader(request);

    if (headerRestaurantId !== undefined) {
      return this.resolveFromHeader(userId, headerRestaurantId);
    }

    const active = await this.memberships.findActiveByUser(userId);
    if (active.length === 0) {
      throw new ForbiddenError('You do not have access to any restaurant.');
    }
    if (active.length > 1) {
      throw new ForbiddenError('You belong to more than one restaurant — specify X-Restaurant-Id.');
    }
    return this.toTenantContext(active[0]!);
  }

  private async resolveFromHeader(userId: string, restaurantId: string): Promise<TenantContext> {
    if (!UUID_PATTERN.test(restaurantId)) {
      throw new ForbiddenError('You do not have access to this restaurant.');
    }

    const membership = await this.memberships.find(userId, restaurantId);
    if (!membership || membership.status !== 'ACTIVE') {
      await this.audit.record({
        actorType: 'RESTAURANT_USER',
        actorId: userId,
        action: 'TENANT_ISOLATION_VIOLATION',
        entityType: 'Restaurant',
        entityId: restaurantId,
        reason: 'X-Restaurant-Id did not match an active membership for the authenticated user.',
      });
      throw new ForbiddenError('You do not have access to this restaurant.');
    }

    return this.toTenantContext(membership);
  }

  private toTenantContext(membership: RestaurantStaff): TenantContext {
    return {
      restaurantId: membership.restaurantId,
      staffId: membership.id,
      role: membership.role,
    };
  }

  private readRestaurantIdHeader(request: AuthenticatedRequest): string | undefined {
    const raw = request.headers['x-restaurant-id'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value && value.length > 0 ? value : undefined;
  }
}
