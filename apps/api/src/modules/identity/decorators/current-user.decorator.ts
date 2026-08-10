import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { AuthenticatedRequest } from '../guards/auth.guard.js';

/**
 * Reads the principal AuthGuard already attached to the request. Only
 * valid on routes guarded by AuthGuard — there is no fallback lookup
 * here, by design: a route that forgets `@UseGuards(AuthGuard)` should
 * fail loudly (`request.user` undefined) rather than this decorator
 * silently doing its own auth.
 */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): User => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.user) {
    throw new Error('CurrentUser() used on a route without AuthGuard applied.');
  }
  return request.user;
});
