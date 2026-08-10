import { z } from 'zod';

export const AcceptInvitationDto = z.object({
  token: z.string().trim().min(1),
});

export type AcceptInvitationInput = z.infer<typeof AcceptInvitationDto>;
