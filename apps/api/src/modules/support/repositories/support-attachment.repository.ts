import { Inject, Injectable } from '@nestjs/common';
import type { SupportAttachment } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateSupportAttachmentInput {
  caseId: string;
  messageId: string;
  uploadedByType: string;
  uploadedById?: string;
  objectKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

@Injectable()
export class SupportAttachmentRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateSupportAttachmentInput): Promise<SupportAttachment> {
    return this.prisma.supportAttachment.create({ data: input });
  }

  async findById(id: string): Promise<SupportAttachment | null> {
    return this.prisma.supportAttachment.findUnique({ where: { id } });
  }

  /** BR-140 / tenant check: an attachment is only ever fetched scoped to the case it's known to belong to — `SupportAttachmentService` always resolves the case ownership first, then calls this with the already-authorized `caseId`. */
  async findByIdForCase(id: string, caseId: string): Promise<SupportAttachment | null> {
    return this.prisma.supportAttachment.findFirst({ where: { id, caseId } });
  }
}
