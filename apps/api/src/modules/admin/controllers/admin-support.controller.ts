import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { SupportCase, SupportCaseStatus, SupportMessage } from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { CurrentAdmin } from '../../../platform/authorization/current-admin.decorator.js';
import type { AdminContext } from '../../../platform/authorization/admin-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { SupportCaseRepository } from '../../support/repositories/support-case.repository.js';
import { SupportMessageRepository } from '../../support/repositories/support-message.repository.js';
import { SupportAttachmentService } from '../../support/services/support-attachment.service.js';
import { SupportCaseService } from '../../support/services/support-case.service.js';
import { PostAgentSupportMessageDto } from '../../support/dto/post-support-message.dto.js';
import { PresignSupportAttachmentDto } from '../../support/dto/presign-support-attachment.dto.js';
import { AssignSupportCaseDto, ResolveSupportCaseDto } from '../../support/dto/assign-support-case.dto.js';
import { AdminSupportService } from '../services/admin-support.service.js';

const CASE_STATUSES: SupportCaseStatus[] = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'WAITING_CUSTOMER',
  'WAITING_RESTAURANT',
  'WAITING_PROVIDER',
  'RESOLVED',
  'CLOSED',
];

/** `/admin/support/cases*` (docs/04-api-specification.md §8.7). `GET`/list-detail need only `support:read`; assign needs `support:assign`; posting an INTERNAL message needs `support:internal_notes` (checked in the handler, since it depends on the request body, not just the route — `support:read` alone would let a SUPPORT/OPS/FINANCE-without-internal-notes-permission agent see the queue but never write a note only `support:internal_notes` holders can). */
@Controller('admin/support/cases')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminSupportController {
  constructor(
    @Inject(SupportCaseRepository) private readonly cases: SupportCaseRepository,
    @Inject(SupportMessageRepository) private readonly messages: SupportMessageRepository,
    @Inject(SupportCaseService) private readonly caseService: SupportCaseService,
    @Inject(SupportAttachmentService) private readonly attachmentService: SupportAttachmentService,
    @Inject(AdminSupportService) private readonly adminSupport: AdminSupportService,
  ) {}

  @Get()
  @Permissions('support:read')
  @HttpCode(200)
  async list(
    @Query('status') status?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parseLimit(limitRaw);
    if (status !== undefined && !CASE_STATUSES.includes(status as SupportCaseStatus)) {
      throw new ValidationError(`status must be one of ${CASE_STATUSES.join(', ')}.`);
    }
    const page = await this.cases.listForAdmin(
      { status: status as SupportCaseStatus | undefined, assignedToUserId: assignedToUserId === 'unassigned' ? null : assignedToUserId },
      { cursor, limit },
    );
    return okPage(page.items.map(toAdminCase), {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: limit ?? 20,
    });
  }

  @Get(':id')
  @Permissions('support:read')
  @HttpCode(200)
  async detail(@Param('id') id: string) {
    const found = await this.caseService.requireById(id);
    const allMessages = await this.messages.listAllForCase(found.id);
    return ok({ ...toAdminCase(found), messages: allMessages.map(toAdminMessage) });
  }

  @Post(':id/assign')
  @Permissions('support:assign')
  @HttpCode(200)
  async assign(@CurrentAdmin() admin: AdminContext, @Param('id') id: string, @Body() body: unknown) {
    const found = await this.caseService.requireById(id);
    const input = AssignSupportCaseDto.parse(body);
    const updated = await this.adminSupport.assign(found, input.assignedToUserId, admin.adminUserId);
    return ok(toAdminCase(updated));
  }

  @Post(':id/messages')
  @Permissions('support:read')
  @HttpCode(201)
  async postMessage(@CurrentAdmin() admin: AdminContext, @Param('id') id: string, @Body() body: unknown) {
    const found = await this.caseService.requireById(id);
    const input = PostAgentSupportMessageDto.parse(body);
    if (input.visibility === 'INTERNAL' && !hasInternalNotesRole(admin.role)) {
      throw new ValidationError('This role cannot post INTERNAL notes.');
    }
    const message = await this.adminSupport.postMessage(
      found,
      admin.adminUserId,
      input.body,
      input.visibility,
      input.attachments,
    );
    return ok(toAdminMessage(message));
  }

  @Post(':id/resolve')
  @Permissions('support:read')
  @HttpCode(200)
  async resolve(@CurrentAdmin() admin: AdminContext, @Param('id') id: string, @Body() body: unknown) {
    const found = await this.caseService.requireById(id);
    const input = ResolveSupportCaseDto.parse(body);
    const updated = await this.adminSupport.resolve(found, input.resolutionNote, admin.adminUserId);
    return ok(toAdminCase(updated));
  }

  @Post(':id/attachments/presign')
  @Permissions('support:read')
  @HttpCode(200)
  async presignAttachment(@Param('id') id: string, @Body() body: unknown) {
    const found = await this.caseService.requireById(id);
    const input = PresignSupportAttachmentDto.parse(body);
    return ok(await this.attachmentService.presign(found.id, input));
  }

  /** No `publicOnly` restriction — an agent can see every attachment on a case, same as `listAllForCase`. */
  @Get(':id/attachments/:attachmentId')
  @Permissions('support:read')
  @HttpCode(200)
  async downloadAttachment(@Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    const found = await this.caseService.requireById(id);
    const url = await this.attachmentService.presignDownload(found.id, attachmentId);
    return ok({ url });
  }
}

/** `support:internal_notes` holders (SUPPORT/OPS/FINANCE/SUPER_ADMIN — never MANAGER/OWNER, and this controller is admin-only anyway) — mirrors `permission.catalogue.ts`'s own matrix row rather than re-deriving it from `hasPermission`, since the controller-level `@Permissions('support:read')` guard already ran and only needs this second, body-dependent check. */
function hasInternalNotesRole(role: string): boolean {
  return role === 'SUPPORT' || role === 'ADMIN_OPERATIONS' || role === 'ADMIN_FINANCE' || role === 'SUPER_ADMIN';
}

function toAdminCase(supportCase: SupportCase) {
  return {
    id: supportCase.id,
    caseNumber: supportCase.caseNumber,
    customerId: supportCase.customerId,
    restaurantId: supportCase.restaurantId,
    orderId: supportCase.orderId,
    category: supportCase.category,
    priority: supportCase.priority,
    status: supportCase.status,
    subject: supportCase.subject,
    description: supportCase.description,
    assignedToUserId: supportCase.assignedToUserId,
    resolvedAt: supportCase.resolvedAt,
    resolutionNote: supportCase.resolutionNote,
    firstResponseAt: supportCase.firstResponseAt,
    createdAt: supportCase.createdAt,
  };
}

function toAdminMessage(message: SupportMessage) {
  return {
    id: message.id,
    authorType: message.authorType,
    authorId: message.authorId,
    visibility: message.visibility,
    body: message.body,
    createdAt: message.createdAt,
  };
}

function parseLimit(limitRaw?: string): number | undefined {
  if (limitRaw === undefined) return undefined;
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new ValidationError('limit must be a positive integer.');
  }
  return limit;
}
