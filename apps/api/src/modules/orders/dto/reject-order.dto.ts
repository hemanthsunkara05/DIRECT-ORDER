import { z } from 'zod';

/** `POST /restaurant/orders/:id/reject` — a reason is mandatory (docs/03-state-machines.md §7.1: "Reason required"). */
export const RejectOrderDto = z.object({
  reason: z.string().trim().min(1).max(500),
});

export type RejectOrderInput = z.infer<typeof RejectOrderDto>;
