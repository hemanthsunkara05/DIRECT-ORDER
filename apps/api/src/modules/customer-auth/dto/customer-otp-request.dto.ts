import { z } from 'zod';

export const CustomerOtpRequestDto = z.object({
  phone: z.string().trim().min(6).max(20),
});

export type CustomerOtpRequestInput = z.infer<typeof CustomerOtpRequestDto>;
