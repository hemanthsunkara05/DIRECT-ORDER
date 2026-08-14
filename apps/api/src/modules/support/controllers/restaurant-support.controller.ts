import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { SupportCase, SupportMessage, User } from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { SupportCaseRepository } from '../repositories/support-case.repository.js';
import { SupportMessageRepository } from '../repositories/support-message.repository.js';
import { SupportAttachmentService } from '../services/support-attachment.service.js';
import { SupportCaseService } from '../services/support-case.service.js';
import { CreateSupportCaseDto } from '../dto/create-support-case.dto.js';
import { PostSupportMessageDto } from '../dto/post-support-message.dto.js';
import { PresignSupportAttachmentDto } from '../dto/presign-support-attachment.dto.js';

/** `/restaurant/support/cases*` (docs/04-api-specification.md §8.5, MANAGER minimum via `support:read`/`support:write`). BR-135: every read/write below is scoped to `tenant.restaurantId` — never a client-supplied restaurant id. */
@Controller('restaurant/support/cases')
@UseGuards(AuthGuard, AuthorizationGuard)
export class RestaurantSupportController {
  constructor(
    @Inject(SupportCaseRepository) private readonly cases: SupportCaseRepository,
    @Inject(SupportMessageRepository) private readonly messages: SupportMessageRepository,
    @Inject(SupportCaseService) private readonly caseService: SupportCaseService,
    @Inject(SupportAttachmentService) private readonly attachmentService: SupportAttachmentService,
  ) {}

  @Get()
  @TenantScoped()
  @Permissions('support:read')
  @HttpCode(200)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parseLimit(limitRaw);
    const page = await this.cases.listForRestaurant(tenant.restaurantId, { cursor, limit });
    return okPage(page.items.map(toCaseSummary), {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: limit ?? 20,
    });
  }

  @Post()
  @TenantScoped()
  @Permissions('support:write')
  @HttpCode(201)
  async create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const input = CreateSupportCaseDto.parse(body);
    const created = await this.caseService.createForRestaurant(tenant.restaurantId, input);
    return ok(toCaseSummary(created));
  }

  @Get(':id')
  @TenantScoped()
  @Permissions('support:read')
  @HttpCode(200)
  async detail(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    const found = await this.caseService.requireForRestaurant(id, tenant.restaurantId);
    const publicMessages = await this.messages.listPublicForCase(found.id);
    return ok({ ...toCaseSummary(found), messages: publicMessages.map(toPublicMessage) });
  }

  @Post(':id/messages')
  @TenantScoped()
  @Permissions('support:write')
  @HttpCode(201)
  async postMessage(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const found = await this.caseService.requireForRestaurant(id, tenant.restaurantId);
    const input = PostSupportMessageDto.parse(body);
    const message = await this.caseService.postAsRestaurant(found, user.id, input.body, input.attachments);
    return ok(toPublicMessage(message));
  }

  @Post(':id/attachments/presign')
  @TenantScoped()
  @Permissions('support:write')
  @HttpCode(200)
  async presignAttachment(@CurrentTenant() tenant: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const found = await this.caseService.requireForRestaurant(id, tenant.restaurantId);
    const input = PresignSupportAttachmentDto.parse(body);
    return ok(await this.attachmentService.presign(found.id, input));
  }

  @Get(':id/attachments/:attachmentId')
  @TenantScoped()
  @Permissions('support:read')
  @HttpCode(200)
  async downloadAttachment(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const found = await this.caseService.requireForRestaurant(id, tenant.restaurantId);
    const url = await this.attachmentService.presignDownload(found.id, attachmentId, { publicOnly: true });
    return ok({ url });
  }
}

function parseLimit(limitRaw?: string): number | undefined {
  if (limitRaw === undefined) return undefined;
  const limit = Number.parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new ValidationError('limit must be a positive integer.');
  }
  return limit;
}

function toCaseSummary(supportCase: SupportCase) {
  return {
    id: supportCase.id,
    caseNumber: supportCase.caseNumber,
    category: supportCase.category,
    priority: supportCase.priority,
    status: supportCase.status,
    subject: supportCase.subject,
    description: supportCase.description,
    orderId: supportCase.orderId,
    resolvedAt: supportCase.resolvedAt,
    resolutionNote: supportCase.resolutionNote,
    firstResponseAt: supportCase.firstResponseAt,
    createdAt: supportCase.createdAt,
  };
}

function toPublicMessage(message: SupportMessage) {
  return {
    id: message.id,
    authorType: message.authorType,
    body: message.body,
    createdAt: message.createdAt,
  };
}
