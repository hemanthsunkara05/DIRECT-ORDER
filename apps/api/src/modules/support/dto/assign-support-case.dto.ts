import { z } from 'zod';

export const AssignSupportCaseDto = z.object({
  assignedToUserId: z.string().uuid(),
});

export type AssignSupportCaseInput = z.infer<typeof AssignSupportCaseDto>;

export const ResolveSupportCaseDto = z.object({
  resolutionNote: z.string().trim().min(1).max(2000),
});

export type ResolveSupportCaseInput = z.infer<typeof ResolveSupportCaseDto>;
