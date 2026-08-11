import { Inject, Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../../../platform/errors/app-error.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { AdminUserRepository } from '../../../platform/authorization/admin-user.repository.js';
import { UserRepository } from '../../identity/repositories/user.repository.js';
import { SessionRepository } from '../../identity/repositories/session.repository.js';

/**
 * `POST /admin/users/:id/disable` (docs/04 §8.7, SUPER_ADMIN-only:
 * "Revokes sessions"). `:id` is a `User` id — this disables ANY user
 * (restaurant staff, a future registered customer, or an admin), not
 * only ones with an AdminUser row; `GET /admin/users` lists every user
 * platform-wide, and this is the one action taken against a row from
 * that list. docs/01-domain-model.md §5.2's AdminUser constraint — "The
 * system must always retain at least one active SUPER_ADMIN" — is
 * enforced here the same way `LastOwnerError` guards a restaurant's
 * last active OWNER (Phase 5): checked inside the same operation,
 * against a live count, never assumed from stale state.
 */
@Injectable()
export class AdminUserService {
  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(AdminUserRepository) private readonly adminUsers: AdminUserRepository,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async disable(targetUserId: string, actorAdminUserId: string): Promise<void> {
    const target = await this.users.findById(targetUserId);
    if (!target) {
      throw new NotFoundError('User not found.');
    }

    const adminRole = await this.adminUsers.findActiveRoleByUserId(targetUserId);
    if (adminRole === 'SUPER_ADMIN') {
      const activeSuperAdmins = await this.adminUsers.countActiveByRole('SUPER_ADMIN');
      if (activeSuperAdmins <= 1) {
        throw new ConflictError('The last active SUPER_ADMIN cannot be disabled.');
      }
    }

    await this.users.setStatus(targetUserId, 'DISABLED');
    await this.sessions.revokeAllForUser(targetUserId, 'Disabled by an administrator.');

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: actorAdminUserId,
      action: 'USER_DISABLED',
      entityType: 'User',
      entityId: targetUserId,
      before: { status: target.status },
      after: { status: 'DISABLED' },
    });
  }
}
