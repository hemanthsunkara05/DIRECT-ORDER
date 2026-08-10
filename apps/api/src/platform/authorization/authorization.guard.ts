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
import type { TenantContext } from './tenant-context.js';

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
 * Only ever resolves a **restaurant** role (STAFF/MANAGER/OWNER) today —
 * admin_users (SUPPORT/OPS/FINANCE/SUPER_ADMIN) is a Phase 13 table.
 * A route requiring only admin-capable permissions therefore always
 * denies right now; there is no principal type yet that could satisfy
 * it. Phase 13 extends `resolveTenant`'s admin branch, not this file's
 * overall structure.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RestaurantMembershipRepository)
    private readonly memberships: RestaurantMembershipRepository,
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
      // Permissions required but no restaurant tenant to resolve a role
      // from — see the class doc comment: no admin principal exists yet.
      throw new ForbiddenError();
    }

    const tenant = await this.resolveTenant(request);
    (request as AuthenticatedRequest & { tenant: TenantContext }).tenant = tenant;

    if (permissions.length > 0 && !permissions.every((p) => hasPermission(tenant.role, p))) {
      throw new ForbiddenError();
    }

    return true;
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
