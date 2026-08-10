import { z } from 'zod';

/**
 * Environment variables the codebase actually reads today. Extend this
 * schema in the same commit that adds the code which reads a new
 * variable — never add a variable here "for later" (see
 * PRODUCT/docs/16-execution-protocol.md §24.6, scope discipline).
 *
 * `APP_ENV=production` triggers strict validation: every field below is
 * required regardless of environment, so a production deploy with a
 * missing APP_DATABASE_URL fails at startup with a named variable rather
 * than surfacing as a confusing runtime error later
 * (PRODUCT/docs/14-acceptance-criteria.md, Phase 1).
 *
 * Note: `DATABASE_URL` (the owner/migration role) is intentionally NOT
 * read here. It is used only by the Prisma CLI (`prisma migrate`,
 * `pnpm db:grants`) — a separate process from the running application —
 * so it has no place in this application's own env schema. The
 * application connects using `APP_DATABASE_URL`, the restricted runtime
 * role (Phase 2, docs/02-database-schema.md, audit_logs).
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_BASE_URL: z.string().url(),
  WEB_BASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  APP_DATABASE_URL: z.string().min(1, 'APP_DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // Phase 3: required now — rate limiting (docs/09-security.md §15.7) and
  // session-adjacent state depend on Redis being reachable.
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Phase 3: authentication.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900), // 15 min
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().min(1).optional(),
  ARGON2_MEMORY_KB: z.coerce.number().int().positive().default(65536),

  // Phase 5: presigned image uploads (docs/09-security.md §15.6).
  // S3-compatible — MinIO locally (docker-compose.yml), a real bucket
  // in production. STORAGE_REGION defaults to a placeholder MinIO
  // accepts; only a real S3 deployment needs a real AWS region.
  STORAGE_ENDPOINT: z.string().url(),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_ACCESS_KEY: z.string().min(1),
  STORAGE_SECRET_KEY: z.string().min(1),
  STORAGE_REGION: z.string().min(1).default('us-east-1'),
  CDN_BASE_URL: z.string().url(),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Fields that MUST be present (non-empty, non-placeholder) when
 * APP_ENV=production, even though EnvSchema itself treats them as
 * having safe local defaults or being merely present-if-provided.
 * PORT/LOG_LEVEL/JWT_ACCESS_TTL_SECONDS/REFRESH_TOKEN_TTL_DAYS/
 * ARGON2_MEMORY_KB have safe defaults everywhere and are excluded.
 */
const PRODUCTION_REQUIRED_KEYS = [
  'APP_DATABASE_URL',
  'API_BASE_URL',
  'WEB_BASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
] as const;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Parses and validates `process.env`. Throws a single, clearly-worded
 * EnvValidationError naming every missing/invalid variable rather than
 * failing on the first one — a developer fixing configuration should
 * not have to run the app repeatedly to discover each missing value
 * one at a time.
 */
export function validateEnv(raw: NodeJS.ProcessEnv): Env {
  const result = EnvSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new EnvValidationError(issues);
  }

  const env = result.data;

  if (env.APP_ENV === 'production') {
    const missing = PRODUCTION_REQUIRED_KEYS.filter((key) => {
      const value = raw[key];
      return value === undefined || value.trim() === '';
    });
    if (missing.length > 0) {
      throw new EnvValidationError(
        missing.map((key) => `${key} is required when APP_ENV=production`),
      );
    }
  }

  return env;
}
