import { z } from 'zod';

/** GET /health — liveness. No dependency checks (see health.controller.ts). */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** GET /ready — readiness. Reflects real dependency state. */
export const ReadinessCheckSchema = z.object({
  status: z.enum(['ok', 'error']),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});
export type ReadinessCheck = z.infer<typeof ReadinessCheckSchema>;

export const ReadyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: ReadinessCheckSchema,
  }),
});
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;
