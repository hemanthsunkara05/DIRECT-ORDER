import { z } from 'zod';

const AttachmentInputSchema = z.object({
  key: z.string().trim().min(1),
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1),
  sizeBytes: z.number().int().positive(),
});

/** Shared by `/me/support/cases/:id/messages` and `/restaurant/support/cases/:id/messages` — both always post PUBLIC (visibility is not client-controlled on either path, only the admin/agent DTO below has that field). */
export const PostSupportMessageDto = z.object({
  body: z.string().trim().min(1).max(5000),
  attachments: z.array(AttachmentInputSchema).max(5).optional(),
});

export type PostSupportMessageInput = z.infer<typeof PostSupportMessageDto>;

/** `/admin/support/cases/:id/messages` — the one path where `visibility` is caller-controlled (BR-136: only reachable behind `support:internal_notes`/`support:read`). */
export const PostAgentSupportMessageDto = PostSupportMessageDto.extend({
  visibility: z.enum(['INTERNAL', 'PUBLIC']).default('PUBLIC'),
});

export type PostAgentSupportMessageInput = z.infer<typeof PostAgentSupportMessageDto>;
