import { z } from 'zod';

export const InviteStaffDto = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['STAFF', 'MANAGER', 'OWNER']),
});

export type InviteStaffInput = z.infer<typeof InviteStaffDto>;
