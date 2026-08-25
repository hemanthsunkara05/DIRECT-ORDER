import { z } from 'zod';

/** `POST /public/orders/:orderNumber/support-cases` — same shape as `CreateSupportCaseDto` minus `orderNumber` (implied by the path) and plus `token` (the guest's proof of ownership, same pattern `order-tracking.controller.ts` already uses for payment verification and reviews). */
export const CreatePublicSupportCaseDto = z.object({
  token: z.string().min(1),
  category: z.enum(['ORDER', 'PAYMENT', 'DELIVERY', 'ACCOUNT', 'RESTAURANT', 'OTHER']),
  subject: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
});

export type CreatePublicSupportCaseInput = z.infer<typeof CreatePublicSupportCaseDto>;

const AttachmentInputSchema = z.object({
  key: z.string().trim().min(1),
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1),
  sizeBytes: z.number().int().positive(),
});

/** `POST /public/orders/:orderNumber/support-cases/:id/messages` — same body as `PostSupportMessageDto` plus `token`. */
export const PostPublicSupportMessageDto = z.object({
  token: z.string().min(1),
  body: z.string().trim().min(1).max(5000),
  attachments: z.array(AttachmentInputSchema).max(5).optional(),
});

export type PostPublicSupportMessageInput = z.infer<typeof PostPublicSupportMessageDto>;

/** `POST /public/orders/:orderNumber/support-cases/:id/attachments/presign` — same body as `PresignSupportAttachmentDto` plus `token`. */
export const PresignPublicSupportAttachmentDto = z.object({
  token: z.string().min(1),
  contentType: z.string().trim().min(1),
  sizeBytes: z.number().int().positive(),
});

export type PresignPublicSupportAttachmentInput = z.infer<typeof PresignPublicSupportAttachmentDto>;
