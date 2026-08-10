import { z } from 'zod';

export const ChangeRoleDto = z.object({
  role: z.enum(['STAFF', 'MANAGER', 'OWNER']),
});

export type ChangeRoleInput = z.infer<typeof ChangeRoleDto>;
