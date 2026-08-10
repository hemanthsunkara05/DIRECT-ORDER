import { z } from 'zod';

export const UpdateCategoryDto = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateCategoryInput = z.infer<typeof UpdateCategoryDto>;
