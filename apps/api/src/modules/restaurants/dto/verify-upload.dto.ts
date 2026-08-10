import { z } from 'zod';

export const VerifyUploadDto = z.object({
  key: z.string().trim().min(1),
  contentType: z.string().trim().min(1).max(100),
});

export type VerifyUploadInput = z.infer<typeof VerifyUploadDto>;
