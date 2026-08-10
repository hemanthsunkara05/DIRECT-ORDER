import { z } from 'zod';

export const LoginDto = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

export type LoginInput = z.infer<typeof LoginDto>;
