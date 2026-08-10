import { z } from 'zod';

export const OtpVerifyDto = z.object({
  identifier: z.string().trim().min(1).max(320),
  purpose: z.enum(['EMAIL_VERIFICATION', 'PHONE_VERIFICATION']),
  code: z.string().trim().length(6),
});

export type OtpVerifyInput = z.infer<typeof OtpVerifyDto>;
