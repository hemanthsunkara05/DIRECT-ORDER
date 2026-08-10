import { z } from 'zod';

export const PresignUploadDto = z.object({
  contentType: z.string().trim().min(1).max(100),
  sizeBytes: z.coerce.number().int().positive(),
});

export type PresignUploadInput = z.infer<typeof PresignUploadDto>;
