import { z } from 'zod';

export const PresignSupportAttachmentDto = z.object({
  contentType: z.string().trim().min(1),
  sizeBytes: z.number().int().positive(),
});

export type PresignSupportAttachmentInput = z.infer<typeof PresignSupportAttachmentDto>;
