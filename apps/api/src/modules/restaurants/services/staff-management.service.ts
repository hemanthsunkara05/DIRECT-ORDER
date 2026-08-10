import { randomBytes, createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { RestaurantStaffRole, StaffInvitation } from '@prisma/client';
import { AuditService } from '../../../platform/audit/audit.service.js';
import {
  ConflictError,
  LastOwnerError,
  NotFoundError,
} from '../../../platform/errors/app-error.js';
import { SessionRepository } from '../../identity/repositories/session.repository.js';
import {
  RestaurantStaffRepository,
  type RestaurantStaffWithUser,
} from '../repositories/restaurant-staff.repository.js';
import { StaffInvitationRepository } from '../repositories/staff-invitation.repository.js';

const INVITATION_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

export interface IssuedInvitation {
  invitation: StaffInvitation;
  /** The raw token — deliver via email; never persisted or logged. Same pattern as OtpService/TokenService. */
  token: string;
}

export type AcceptInvitationResult =
  | { outcome: 'ACCEPTED'; restaurantId: string }
  | { outcome: 'INVALID' | 'EXPIRED' | 'EMAIL_MISMATCH' };

/**
 * Invitations (create/accept/list/revoke) and membership management
 * (role changes, disable) — the last-active-OWNER protection
 * (docs/01-domain-model.md §5.2: "Every restaurant must have at least
 * one ACTIVE OWNER — the last one cannot be removed or demoted") is
 * enforced here, the one place role/status changes happen, not
 * scattered across every call site that might touch a membership.
 */
@Injectable()
export class StaffManagementService {
  constructor(
    @Inject(StaffInvitationRepository) private readonly invitations: StaffInvitationRepository,
    @Inject(RestaurantStaffRepository) private readonly staff: RestaurantStaffRepository,
    @Inject(SessionRepository) private readonly sessions: SessionRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async invite(
    restaurantId: string,
    invitedByUserId: string,
    email: string,
    role: RestaurantStaffRole,
  ): Promise<IssuedInvitation> {
    const normalizedEmail = email.trim().toLowerCase();

    // A fresh invite supersedes any still-pending one for the same
    // email — the old token must stop working once a new one is issued,
    // otherwise both remain independently valid single-use tokens for
    // the same eventual membership.
    const existing = await this.invitations.findPendingByEmail(restaurantId, normalizedEmail);
    if (existing) {
      await this.invitations.revoke(restaurantId, existing.id);
    }

    const token = randomBytes(32).toString('base64url');
    const invitation = await this.invitations.create(restaurantId, {
      email: normalizedEmail,
      role,
      tokenHash: this.hashToken(token),
      invitedByUserId,
      expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * DAY_MS),
    });

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId: invitedByUserId,
      action: 'STAFF_INVITED',
      entityType: 'StaffInvitation',
      entityId: invitation.id,
      restaurantId,
      after: { email: normalizedEmail, role },
    });

    return { invitation, token };
  }

  /**
   * `accepterEmail` is the AUTHENTICATED principal's own email (from
   * the session, via AuthGuard) — never taken from the request body.
   * Accepting requires being logged in as the invited address; there is
   * no path here that creates an account.
   */
  async accept(
    userId: string,
    accepterEmail: string,
    token: string,
  ): Promise<AcceptInvitationResult> {
    const invitation = await this.invitations.findByTokenHash(this.hashToken(token));
    if (!invitation || invitation.status !== 'PENDING') {
      return { outcome: 'INVALID' };
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      return { outcome: 'EXPIRED' };
    }
    if (invitation.email.toLowerCase() !== accepterEmail.trim().toLowerCase()) {
      return { outcome: 'EMAIL_MISMATCH' };
    }

    await this.staff.create(invitation.restaurantId, {
      userId,
      role: invitation.role,
      invitedByUserId: invitation.invitedByUserId,
    });
    await this.invitations.markAccepted(invitation.id);

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId: userId,
      action: 'STAFF_INVITATION_ACCEPTED',
      entityType: 'StaffInvitation',
      entityId: invitation.id,
      restaurantId: invitation.restaurantId,
    });

    return { outcome: 'ACCEPTED', restaurantId: invitation.restaurantId };
  }

  async list(restaurantId: string): Promise<RestaurantStaffWithUser[]> {
    return this.staff.listWithUser(restaurantId);
  }

  async changeRole(
    restaurantId: string,
    actorId: string,
    staffId: string,
    newRole: RestaurantStaffRole,
  ): Promise<void> {
    const target = await this.staff.findById(restaurantId, staffId);
    if (!target) {
      throw new NotFoundError();
    }
    if (target.role === 'OWNER' && newRole !== 'OWNER') {
      // Checked before the (less specific) self-demotion guard below —
      // a sole owner demoting themselves is both at once, and the
      // acceptance criterion (docs/14-acceptance-criteria.md, Phase 5)
      // requires this exact case to surface as 409 LAST_OWNER, not a
      // generic conflict.
      await this.assertNotLastActiveOwner(restaurantId);
    }
    if (target.userId === actorId && target.role === 'OWNER' && newRole !== 'OWNER') {
      // Not required by the last-owner rule alone (there are other
      // owners at this point, or the check above would already have
      // thrown) — self-demotion is a common accidental-click footgun
      // worth blocking outright even when a co-owner exists.
      throw new ConflictError('You cannot change your own OWNER role.');
    }

    const updated = await this.staff.updateRole(restaurantId, staffId, newRole);
    if (!updated) {
      throw new NotFoundError();
    }

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'STAFF_ROLE_CHANGED',
      entityType: 'RestaurantStaff',
      entityId: staffId,
      restaurantId,
      before: { role: target.role },
      after: { role: newRole },
    });
  }

  async disable(restaurantId: string, actorId: string, staffId: string): Promise<void> {
    const target = await this.staff.findById(restaurantId, staffId);
    if (!target) {
      throw new NotFoundError();
    }
    if (target.role === 'OWNER') {
      await this.assertNotLastActiveOwner(restaurantId);
    }

    const updated = await this.staff.setStatus(restaurantId, staffId, 'DISABLED');
    if (!updated) {
      throw new NotFoundError();
    }

    // Disabling a staff member must end their access immediately, not
    // just prevent new logins (docs/09-security.md §15.2: "Session
    // revocation ... staff disable ... revoke immediately").
    await this.sessions.revokeAllForUser(target.userId, 'STAFF_DISABLED');

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'STAFF_DISABLED',
      entityType: 'RestaurantStaff',
      entityId: staffId,
      restaurantId,
    });
  }

  private async assertNotLastActiveOwner(restaurantId: string): Promise<void> {
    const activeOwners = await this.staff.countActiveOwners(restaurantId);
    if (activeOwners <= 1) {
      throw new LastOwnerError();
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
