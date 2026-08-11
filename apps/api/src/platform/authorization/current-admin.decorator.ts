import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../modules/identity/guards/auth.guard.js';
import type { AdminContext } from './admin-context.js';

/** Reads the admin principal AuthorizationGuard resolved. Only valid on `/admin/*` routes guarded by `@Permissions(...)` without `@TenantScoped()`. */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AdminContext => {
    const request = ctx
      .switchToHttp()
      .getRequest<AuthenticatedRequest & { admin?: AdminContext }>();
    if (!request.admin) {
      throw new Error(
        'CurrentAdmin() used on a route AuthorizationGuard did not resolve an admin principal for.',
      );
    }
    return request.admin;
  },
);
