import { z } from 'zod';

export const PasswordForgotDto = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export type PasswordForgotInput = z.infer<typeof PasswordForgotDto>;
