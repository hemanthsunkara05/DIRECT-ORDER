import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../modules/identity/guards/auth.guard.js';
import type { TenantContext } from './tenant-context.js';

/**
 * Reads the tenant AuthorizationGuard resolved. Only valid on routes
 * marked `@TenantScoped()` — same "fail loudly, no silent fallback"
 * philosophy as `@CurrentUser()`.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx
      .switchToHttp()
      .getRequest<AuthenticatedRequest & { tenant?: TenantContext }>();
    if (!request.tenant) {
      throw new Error('CurrentTenant() used on a route without @TenantScoped() applied.');
    }
    return request.tenant;
  },
);
