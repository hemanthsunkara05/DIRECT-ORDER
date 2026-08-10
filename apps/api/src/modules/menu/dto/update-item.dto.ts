import { z } from 'zod';

const DIETARY_TAGS = ['VEG', 'NON_VEG', 'EGG', 'UNKNOWN'] as const;

export const UpdateItemDto = z.object({
  categoryId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  priceMinor: z.coerce.bigint().positive().optional(),
  imageUrl: z.string().trim().url().max(2000).nullable().optional(),
  dietaryTag: z.enum(DIETARY_TAGS).optional(),
  isActive: z.boolean().optional(),
});

export type UpdateItemInput = z.infer<typeof UpdateItemDto>;
