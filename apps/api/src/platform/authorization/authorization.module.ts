import { Global, Module } from '@nestjs/common';
import { RestaurantMembershipRepository } from './restaurant-membership.repository.js';
import { AdminUserRepository } from './admin-user.repository.js';
import { AuthorizationGuard } from './authorization.guard.js';

/**
 * Deliberately NOT registered as a global APP_GUARD, unlike
 * RateLimitGuard — see AuthorizationGuard's own doc comment. Nest runs
 * global guards before controller/method-level ones, so a global
 * AuthorizationGuard would run BEFORE AuthGuard (applied per-controller
 * in modules/identity) and would never see `request.user`. Every
 * tenant-scoped controller instead applies both explicitly, in order:
 * `@UseGuards(AuthGuard, AuthorizationGuard)`.
 *
 * `@Global()` so `RestaurantMembershipRepository`, `AdminUserRepository`
 * (Phase 13), and `AuthorizationGuard` are injectable/usable from any
 * domain module without re-importing this one, matching every other
 * platform-layer module (config, logging, database, audit, redis).
 */
@Global()
@Module({
  providers: [RestaurantMembershipRepository, AdminUserRepository, AuthorizationGuard],
  exports: [RestaurantMembershipRepository, AdminUserRepository, AuthorizationGuard],
})
export class AuthorizationModule {}
