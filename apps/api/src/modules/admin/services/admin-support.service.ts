import { Inject, Injectable } from '@nestjs/common';
import type { SupportCase, SupportMessage } from '@prisma/client';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { SupportCaseService } from '../../support/services/support-case.service.js';
import type { AttachInput } from '../../support/services/support-attachment.service.js';

/**
 * `/admin/support/cases*` (docs/04-api-specification.md §8.7,
 * `support:read`/`support:assign`/`support:internal_notes`). A thin
 * wrapper over `SupportCaseService` — the same service every other
 * principal's support actions already go through — adding only the
 * audit trail BR-139 requires ("every support action on a financial or
 * order entity is audited") for the two actions that actually touch
 * case state on behalf of an agent: assignment and posting a message.
 */
@Injectable()
export class AdminSupportService {
  constructor(
    @Inject(SupportCaseService) private readonly caseService: SupportCaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async assign(supportCase: SupportCase, assignedToUserId: string, actorId: string): Promise<SupportCase> {
    const updated = await this.caseService.assign(supportCase, assignedToUserId);
    await this.audit.record({
      actorType: 'ADMIN',
      actorId,
      action: 'SUPPORT_CASE_ASSIGNED',
      entityType: 'SupportCase',
      entityId: supportCase.id,
      before: { assignedToUserId: supportCase.assignedToUserId },
      after: { assignedToUserId },
    });
    return updated;
  }

  async postMessage(
    supportCase: SupportCase,
    actorId: string,
    body: string,
    visibility: 'INTERNAL' | 'PUBLIC',
    attachments: AttachInput[] = [],
  ): Promise<SupportMessage> {
    const message = await this.caseService.postAsAgent(supportCase, actorId, body, visibility, attachments);
    if (visibility === 'INTERNAL') {
      await this.audit.record({
        actorType: 'ADMIN',
        actorId,
        action: 'SUPPORT_INTERNAL_NOTE_ADDED',
        entityType: 'SupportCase',
        entityId: supportCase.id,
      });
    }
    return message;
  }

  async resolve(supportCase: SupportCase, resolutionNote: string, actorId: string): Promise<SupportCase> {
    const updated = await this.caseService.resolve(supportCase, resolutionNote);
    await this.audit.record({
      actorType: 'ADMIN',
      actorId,
      action: 'SUPPORT_CASE_RESOLVED',
      entityType: 'SupportCase',
      entityId: supportCase.id,
      reason: resolutionNote,
    });
    return updated;
  }
}
