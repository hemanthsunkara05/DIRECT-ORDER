import { z } from 'zod';

/**
 * The standard API response envelope shapes, shared between backend and
 * frontend so both sides agree on the wire format without duplicating
 * the definition. See PRODUCT/docs/04-api-specification.md §8.1.
 *
 * `code` is intentionally an open string, not a closed enum: every
 * domain module (orders, payments, promotions, ...) introduces its own
 * error codes as it is built, and locking this shared package to a
 * fixed enum would force every later phase to modify a package it
 * otherwise has no reason to touch. `PLATFORM_ERROR_CODES` below lists
 * the codes the foundation layer itself can produce; domain packages
 * export and document their own alongside their DTOs.
 */

export const ErrorDetailSchema = z.object({
  field: z.string().optional(),
  message: z.string().optional(),
  was: z.unknown().optional(),
  now: z.unknown().optional(),
});
export type ErrorDetail = z.infer<typeof ErrorDetailSchema>;

export const ErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.array(ErrorDetailSchema).optional(),
  requestId: z.string(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

export const ErrorEnvelopeSchema = z.object({
  error: ErrorBodySchema,
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const PaginationMetaSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int().positive(),
});
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export const ResponseMetaSchema = z.object({
  requestId: z.string(),
  pagination: PaginationMetaSchema.optional(),
});
export type ResponseMeta = z.infer<typeof ResponseMetaSchema>;

/**
 * `{ data, meta }` — the success envelope. `dataSchema` describes the
 * shape of `data` for a specific endpoint; this factory produces a Zod
 * schema for that concrete envelope.
 */
export function successEnvelope<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
    meta: ResponseMetaSchema,
  });
}

/** Error codes the platform foundation layer itself can emit. */
export const PLATFORM_ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type PlatformErrorCode = (typeof PLATFORM_ERROR_CODES)[keyof typeof PLATFORM_ERROR_CODES];
