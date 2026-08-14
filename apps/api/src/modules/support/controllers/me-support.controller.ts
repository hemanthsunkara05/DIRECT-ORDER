import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { Customer, SupportCase, SupportMessage } from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CustomerAccountGuard } from '../../loyalty/guards/customer-account.guard.js';
import { CurrentCustomer } from '../../loyalty/decorators/current-customer.decorator.js';
import { SupportCaseRepository } from '../repositories/support-case.repository.js';
import { SupportMessageRepository } from '../repositories/support-message.repository.js';
import { SupportAttachmentService } from '../services/support-attachment.service.js';
import { SupportCaseService } from '../services/support-case.service.js';
import { CreateSupportCaseDto } from '../dto/create-support-case.dto.js';
import { PostSupportMessageDto } from '../dto/post-support-message.dto.js';
import { PresignSupportAttachmentDto } from '../dto/presign-support-attachment.dto.js';

/**
 * `/me/support/cases*` (docs/04-api-specification.md §8.4). Gated by
 * `CustomerAccountGuard` (Phase 16) — a support conversation benefits
 * from a durable identity far more than Phase 15's one-shot review
 * submission did, so this phase implements the API spec's literal
 * `/me/*` placement rather than reaching for the guest-access-token
 * workaround Phase 15 needed before real customer accounts existed.
 */
@Controller('me/support/cases')
@UseGuards(AuthGuard, CustomerAccountGuard)
export class MeSupportController {
  constructor(
    @Inject(SupportCaseRepository) private readonly cases: SupportCaseRepository,
    @Inject(SupportMessageRepository) private readonly messages: SupportMessageRepository,
    @Inject(SupportCaseService) private readonly caseService: SupportCaseService,
    @Inject(SupportAttachmentService) private readonly attachmentService: SupportAttachmentService,
  ) {}

  @Get()
  @HttpCode(200)
  async list(
    @CurrentCustomer() customer: Customer,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parseLimit(limitRaw);
    const page = await this.cases.listForCustomer(customer.id, { cursor, limit });
    return okPage(page.items.map(toCaseSummary), {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: limit ?? 20,
    });
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentCustomer() customer: Customer, @Body() body: unknown) {
    const input = CreateSupportCaseDto.parse(body);
    const created = await this.caseService.createForCustomer(customer.id, input);
    return ok(toCaseSummary(created));
  }

  @Get(':id')
  @HttpCode(200)
  async detail(@CurrentCustomer() customer: Customer, @Param('id') id: string) {
    const found = await this.caseService.requireForCustomer(id, customer.id);
    const publicMessages = await this.messages.listPublicForCase(found.id);
    return ok({ ...toCaseSummary(found), messages: publicMessages.map(toPublicMessage) });
  }

  @Post(':id/messages')
  @HttpCode(201)
  async postMessage(@CurrentCustomer() customer: Customer, @Param('id') id: string, @Body() body: unknown) {
    const found = await this.caseService.requireForCustomer(id, customer.id);
    const input = PostSupportMessageDto.parse(body);
    const message = await this.caseService.postAsCustomer(found, customer.id, input.body, input.attachments);
    return ok(toPublicMessage(message));
  }

  @Post(':id/attachments/presign')
  @HttpCode(200)
  async presignAttachment(@CurrentCustomer() customer: Customer, @Param('id') id: string, @Body() body: unknown) {
    const found = await this.caseService.requireForCustomer(id, customer.id);
    const input = PresignSupportAttachmentDto.parse(body);
    return ok(await this.attachmentService.presign(found.id, input));
  }

  @Get(':id/attachments/:attachmentId')
  @HttpCode(200)
  async downloadAttachment(
    @CurrentCustomer() customer: Customer,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const found = await this.caseService.requireForCustomer(id, customer.id);
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

/** BR-136 at the response-shape level too: only ever built from `listPublicForCase`'s already-filtered rows — there is no `visibility` field left to accidentally leak here since every row passed in is already known-PUBLIC. */
function toPublicMessage(message: SupportMessage) {
  return {
    id: message.id,
    authorType: message.authorType,
    body: message.body,
    createdAt: message.createdAt,
  };
}
