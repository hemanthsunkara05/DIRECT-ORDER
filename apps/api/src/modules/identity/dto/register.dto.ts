import { z } from 'zod';

/**
 * Password policy is NOT enforced here (min length etc.) — that lives in
 * PasswordService.validatePolicy, which returns field-level issues the
 * controller can surface. This schema only enforces shape, matching
 * docs/09-security.md §15.4 ("Zod at every boundary"); unknown fields
 * (notably `role`, `status`) are stripped by z.object's default behaviour.
 */
export const RegisterDto = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});

export type RegisterInput = z.infer<typeof RegisterDto>;
