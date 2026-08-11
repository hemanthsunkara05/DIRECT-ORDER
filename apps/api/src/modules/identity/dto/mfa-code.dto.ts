import { z } from 'zod';

export const MfaCodeDto = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Must be a 6-digit code.'),
});

export type MfaCodeInput = z.infer<typeof MfaCodeDto>;
