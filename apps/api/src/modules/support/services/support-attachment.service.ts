import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { SupportAttachment } from '@prisma/client';
import { STORAGE_PORT, type StoragePort } from '../../restaurants/uploads/storage.port.js';
import { contentMatchesDeclaredAttachmentType } from '../../restaurants/uploads/magic-bytes.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { SupportAttachmentRepository } from '../repositories/support-attachment.repository.js';
import { SupportMessageRepository } from '../repositories/support-message.repository.js';

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB — comfortably covers a screenshot or a scanned receipt PDF.
const PRESIGN_PUT_TTL_SECONDS = 300;
const PRESIGN_GET_TTL_SECONDS = 60; // short-lived by design (BR-140) — re-requested each time a case is viewed, never cached long-term.

export interface PresignAttachmentInput {
  contentType: string;
  sizeBytes: number;
}

export interface AttachInput {
  key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * BR-140: "attachments are private, size- and type-validated, and
 * served via short-lived signed URLs only." The storage key namespace
 * (`support-cases/{caseId}/...`) is itself the tenant boundary — the
 * same "the key prefix IS the ownership check" call `UploadService`
 * already makes for `restaurants/{restaurantId}/...` — never a public
 * CDN URL the way branding images get, matching this feature's
 * "private storage" requirement instead of "public asset" (Phase 5's).
 */
@Injectable()
export class SupportAttachmentService {
  constructor(
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(SupportAttachmentRepository) private readonly attachments: SupportAttachmentRepository,
    @Inject(SupportMessageRepository) private readonly messages: SupportMessageRepository,
  ) {}

  async presign(caseId: string, input: PresignAttachmentInput): Promise<{ key: string; uploadUrl: string; expiresInSeconds: number }> {
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
      throw new ValidationError(`Unsupported content type: ${input.contentType}.`);
    }
    if (input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new ValidationError(`File size must be between 1 and ${MAX_UPLOAD_BYTES} bytes.`);
    }
    const key = `support-cases/${caseId}/${randomUUID()}`;
    const uploadUrl = await this.storage.presignPut(key, input.contentType, PRESIGN_PUT_TTL_SECONDS);
    return { key, uploadUrl, expiresInSeconds: PRESIGN_PUT_TTL_SECONDS };
  }

  /**
   * Verifies each declared attachment's actual bytes (the same
   * content-mismatch defence `UploadService.verify` established) and
   * links it to `messageId`. Called from `SupportCaseService`'s
   * message-posting paths — never exposed as a standalone endpoint,
   * so an attachment can never exist unlinked to the message it was
   * uploaded for.
   */
  async attachToMessage(
    caseId: string,
    messageId: string,
    uploadedByType: string,
    uploadedById: string | undefined,
    inputs: AttachInput[],
  ): Promise<SupportAttachment[]> {
    const created: SupportAttachment[] = [];
    for (const input of inputs) {
      if (!input.key.startsWith(`support-cases/${caseId}/`)) {
        throw new ForbiddenError();
      }
      const bytes = await this.storage.getObject(input.key);
      if (!bytes) {
        throw new NotFoundError('Uploaded file not found — it may have expired before this message was sent.');
      }
      if (!contentMatchesDeclaredAttachmentType(bytes, input.contentType)) {
        await this.storage.deleteObject(input.key);
        throw new ValidationError('The uploaded file does not match its declared type.');
      }
      created.push(
        await this.attachments.create({
          caseId,
          messageId,
          uploadedByType,
          uploadedById,
          objectKey: input.key,
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
        }),
      );
    }
    return created;
  }

  /**
   * `publicOnly` is set by the customer/restaurant controllers (never
   * the admin one) — `SupportAttachment` has no `visibility` of its
   * own (only the parent `SupportMessage` does), so BR-136 ("INTERNAL
   * never returned by a customer-/restaurant-facing endpoint") is
   * enforced here by looking the parent message up and checking ITS
   * visibility before ever issuing a signed URL for the file.
   */
  async presignDownload(caseId: string, attachmentId: string, options: { publicOnly: boolean } = { publicOnly: false }): Promise<string> {
    const attachment = await this.attachments.findByIdForCase(attachmentId, caseId);
    if (!attachment) {
      throw new NotFoundError('Attachment not found.');
    }
    if (options.publicOnly) {
      const message = await this.messages.findById(attachment.messageId);
      if (!message || message.visibility !== 'PUBLIC') {
        throw new NotFoundError('Attachment not found.');
      }
    }
    return this.storage.presignGet(attachment.objectKey, PRESIGN_GET_TTL_SECONDS);
  }
}
