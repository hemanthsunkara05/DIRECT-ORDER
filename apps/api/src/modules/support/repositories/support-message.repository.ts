import { Inject, Injectable } from '@nestjs/common';
import type { SupportMessage, SupportMessageAuthorType, SupportMessageVisibility } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateSupportMessageInput {
  caseId: string;
  authorType: SupportMessageAuthorType;
  authorId?: string;
  visibility?: SupportMessageVisibility;
  body: string;
}

/**
 * BR-136: "INTERNAL messages must never be returned by any customer-
 * or restaurant-facing endpoint. Enforce in the query layer, not by
 * filtering in the frontend." `listPublicForCase` is the ONLY read
 * method `SupportCaseService`'s customer/restaurant-facing paths ever
 * call — it hard-codes `visibility: 'PUBLIC'` in its own `WHERE`
 * clause, not as an optional filter a caller could omit.
 * `listAllForCase` (unfiltered) exists as a clearly separate method,
 * called only from the admin/agent path, so the two can never be
 * confused at a call site.
 */
@Injectable()
export class SupportMessageRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateSupportMessageInput): Promise<SupportMessage> {
    return this.prisma.supportMessage.create({
      data: {
        caseId: input.caseId,
        authorType: input.authorType,
        authorId: input.authorId,
        visibility: input.visibility ?? 'PUBLIC',
        body: input.body,
      },
    });
  }

  /** `SupportAttachmentService.presignDownload`'s visibility check — `SupportAttachment` has no `visibility` of its own (BR-140's doc comment: denormalises `caseId` but not visibility), so a customer/restaurant download request must look up the parent message's visibility here before serving a signed URL. */
  async findById(id: string): Promise<SupportMessage | null> {
    return this.prisma.supportMessage.findUnique({ where: { id } });
  }

  /** Customer/restaurant-facing reads — PUBLIC only, structurally. */
  async listPublicForCase(caseId: string): Promise<SupportMessage[]> {
    return this.prisma.supportMessage.findMany({
      where: { caseId, visibility: 'PUBLIC' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Admin/agent-facing reads only — every message, both visibilities. */
  async listAllForCase(caseId: string): Promise<SupportMessage[]> {
    return this.prisma.supportMessage.findMany({
      where: { caseId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Used by `SupportCaseService` to decide whether `firstResponseAt` should be set — has any PUBLIC AGENT message been posted to this case yet? */
  async findFirstPublicAgentMessage(caseId: string): Promise<SupportMessage | null> {
    return this.prisma.supportMessage.findFirst({
      where: { caseId, visibility: 'PUBLIC', authorType: 'AGENT' },
      orderBy: { createdAt: 'asc' },
    });
  }
}
