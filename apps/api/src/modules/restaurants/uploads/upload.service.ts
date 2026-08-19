import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../platform/errors/app-error.js';
import { STORAGE_PORT, type StoragePort } from './storage.port.js';
import { contentMatchesDeclaredType } from './magic-bytes.js';

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB — comfortably covers a branding logo/cover image
const PRESIGN_TTL_SECONDS = 300;

export interface PresignUploadInput {
  contentType: string;
  sizeBytes: number;
}

export interface PresignedUpload {
  key: string;
  uploadUrl: string;
  publicUrl: string;
  expiresInSeconds: number;
}

export type VerifyUploadResult = 'VERIFIED' | 'CONTENT_MISMATCH' | 'NOT_FOUND';

/**
 * Two-step upload (docs/09-security.md §15.6): `presign` validates the
 * DECLARED type/size and hands back a time-limited URL the client PUTs
 * bytes to directly (the API never touches the bytes at this step —
 * that is the point of a presigned upload). `verify` is the
 * post-upload content check — it fetches what actually landed in
 * storage and confirms the magic bytes match what was declared,
 * deleting the object and rejecting on any mismatch. A `.exe` renamed
 * to `.jpg` passes `presign` (the client can declare whatever type it
 * wants) but is caught here, which is the whole reason `verify` exists
 * as a separate step rather than trusting `presign`'s check alone.
 */
@Injectable()
export class UploadService {
  constructor(
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async presign(restaurantId: string, input: PresignUploadInput): Promise<PresignedUpload> {
    // SVG is checked and rejected explicitly, ahead of the allowlist
    // check, so the error message names the actual reason (executable
    // script content) rather than just "unsupported type."
    if (input.contentType === 'image/svg+xml') {
      throw new ValidationError('SVG uploads are not allowed — SVG can embed executable script.');
    }
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
      throw new ValidationError(`Unsupported content type: ${input.contentType}.`);
    }
    if (input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES) {
      throw new ValidationError(`File size must be between 1 and ${MAX_UPLOAD_BYTES} bytes.`);
    }

    // Server-generated key (UUID + extension), never client-supplied —
    // a client cannot choose where in the bucket its file lands.
    const key = `restaurants/${restaurantId}/${randomUUID()}.${EXTENSION_BY_TYPE[input.contentType]}`;
    const uploadUrl = await this.storage.presignPut(key, input.contentType, PRESIGN_TTL_SECONDS);

    return {
      key,
      uploadUrl,
      publicUrl: `${this.env.CDN_BASE_URL}/${key}`,
      expiresInSeconds: PRESIGN_TTL_SECONDS,
    };
  }

  async verify(
    restaurantId: string,
    actorId: string,
    key: string,
    declaredContentType: string,
    // Phase 23a: an admin-gated caller (`AdminUploadController`) passes
    // 'ADMIN' here instead — same method, same tenant-namespace check
    // below (still correct: the target restaurant is still whichever
    // `restaurantId` the key namespace names), just attributed
    // correctly in the audit log rather than misrecorded as the
    // restaurant's own staff acting.
    actorType: 'RESTAURANT_USER' | 'ADMIN' = 'RESTAURANT_USER',
  ): Promise<VerifyUploadResult> {
    // The key namespace (restaurants/{restaurantId}/...) is itself a
    // tenant check — a caller cannot verify (and thereby probe the
    // existence of) another restaurant's upload.
    if (!key.startsWith(`restaurants/${restaurantId}/`)) {
      throw new ForbiddenError();
    }

    const bytes = await this.storage.getObject(key);
    if (!bytes) {
      throw new NotFoundError();
    }

    if (!contentMatchesDeclaredType(bytes, declaredContentType)) {
      await this.storage.deleteObject(key);
      await this.audit.record({
        actorType,
        actorId,
        action: 'UPLOAD_CONTENT_MISMATCH_REJECTED',
        entityType: 'Upload',
        entityId: key,
        restaurantId,
        reason: `Declared content type ${declaredContentType} did not match the uploaded bytes.`,
      });
      return 'CONTENT_MISMATCH';
    }

    return 'VERIFIED';
  }
}
