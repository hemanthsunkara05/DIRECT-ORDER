import { z } from 'zod';

export const PasswordResetDto = z.object({
  token: z.string().trim().min(1),
  newPassword: z.string().min(1).max(200),
});

export type PasswordResetInput = z.infer<typeof PasswordResetDto>;
