import { SetMetadata } from '@nestjs/common';

export const TENANT_SCOPED_KEY = 'tenantScoped';

/**
 * Marks a route as restaurant-tenant-scoped (docs/04-api-specification.md
 * §8.1: "the restaurant tenant is never in the path or body"). Read by
 * AuthorizationGuard, which resolves the tenant from the authenticated
 * principal's membership (and the `X-Restaurant-Id` header, if the
 * principal belongs to more than one restaurant) and attaches it as
 * `request.tenant` — never from anything client-supplied in the path or
 * body.
 */
export function TenantScoped(): MethodDecorator {
  return SetMetadata(TENANT_SCOPED_KEY, true);
}
