import { z } from 'zod';

/** `orderNumber` (the public, human-readable identifier), never a raw `orderId` — the service resolves and verifies ownership (BR-134) from this before ever touching an internal id, the same "never trust a client-supplied internal id" posture every tenant-scoped lookup in this codebase already takes. */
export const CreateSupportCaseDto = z.object({
  category: z.enum(['ORDER', 'PAYMENT', 'DELIVERY', 'ACCOUNT', 'RESTAURANT', 'OTHER']),
  subject: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  orderNumber: z.string().trim().min(1).max(50).optional(),
});

export type CreateSupportCaseInput = z.infer<typeof CreateSupportCaseDto>;
