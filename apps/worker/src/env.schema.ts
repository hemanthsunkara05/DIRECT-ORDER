import { z } from 'zod';

/**
 * The worker's own minimal environment surface. Deliberately small: no
 * queue consumers exist yet (BullMQ/Redis job processing arrives in
 * Phase 12 alongside the notification system — see
 * PRODUCT/docs/13-implementation-phases.md, Phase 12), so REDIS_URL is
 * not required to be read here yet even though it is already documented
 * in .env.example for that future phase.
 */
export const WorkerEnvSchema = z.object({
  APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export class WorkerEnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid worker environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'WorkerEnvValidationError';
  }
}

export function validateWorkerEnv(raw: NodeJS.ProcessEnv): WorkerEnv {
  const result = WorkerEnvSchema.safeParse(raw);
  if (!result.success) {
    throw new WorkerEnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}
