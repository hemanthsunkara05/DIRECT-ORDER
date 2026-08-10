import { NotFoundError } from '../errors/app-error.js';
import type { AuditService } from '../audit/audit.service.js';

export interface TenantResourceAuditContext {
  audit: AuditService;
  actorId: string;
  restaurantId: string;
  entityType: string;
  entityId: string;
}

/**
 * The resource-scope half of docs/05-authorization-matrix.md §9.1 (the
 * IDOR-prevention layer, distinct from AuthorizationGuard's membership
 * check): a tenant-scoped repository lookup — `findFirst({ ...withTenant(tenant.restaurantId, { id }) })` —
 * returns null when a resource exists but belongs to a DIFFERENT
 * restaurant than the caller's resolved tenant, indistinguishably from
 * "no such resource at all." Every tenant-scoped controller calls this
 * on that null rather than throwing NotFoundError directly, so the
 * 404-vs-403 rule and its audit trail (docs/04-api-specification.md
 * §8.1: "403 vs 404 for cross-tenant access: return 404 ... log it
 * internally as a tenant-isolation event") are enforced identically
 * everywhere instead of each domain module re-implementing it.
 */
export async function assertTenantResourceFound<T>(
  resource: T | null,
  context: TenantResourceAuditContext,
): Promise<T> {
  if (resource) {
    return resource;
  }

  await context.audit.record({
    actorType: 'RESTAURANT_USER',
    actorId: context.actorId,
    action: 'TENANT_ISOLATION_VIOLATION',
    entityType: context.entityType,
    entityId: context.entityId,
    restaurantId: context.restaurantId,
    reason: `Requested ${context.entityType} does not resolve within the caller's tenant restaurant.`,
  });
  throw new NotFoundError();
}
