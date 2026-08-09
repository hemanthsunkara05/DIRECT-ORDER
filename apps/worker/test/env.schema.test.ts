import { describe, expect, it } from 'vitest';
import { validateWorkerEnv, WorkerEnvValidationError } from '../src/env.schema.js';

describe('validateWorkerEnv', () => {
  it('applies safe defaults when nothing is set', () => {
    const env = validateWorkerEnv({});
    expect(env.APP_ENV).toBe('local');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('accepts a valid explicit configuration', () => {
    const env = validateWorkerEnv({ APP_ENV: 'production', LOG_LEVEL: 'warn' });
    expect(env.APP_ENV).toBe('production');
    expect(env.LOG_LEVEL).toBe('warn');
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => validateWorkerEnv({ LOG_LEVEL: 'verbose' })).toThrow(WorkerEnvValidationError);
  });

  it('rejects an invalid APP_ENV', () => {
    expect(() => validateWorkerEnv({ APP_ENV: 'prod' })).toThrow(WorkerEnvValidationError);
  });
});
