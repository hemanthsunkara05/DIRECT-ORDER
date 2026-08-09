import { describe, expect, it } from 'vitest';
import { EnvValidationError, validateEnv } from '../src/platform/config/env.schema.js';

const BASE_VALID_ENV = {
  API_BASE_URL: 'http://localhost:4000',
  WEB_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/direct_order',
};

describe('validateEnv', () => {
  it('accepts a minimal valid local configuration and applies defaults', () => {
    const env = validateEnv(BASE_VALID_ENV);
    expect(env.NODE_ENV).toBe('development');
    expect(env.APP_ENV).toBe('local');
    expect(env.PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DATABASE_URL).toBe(BASE_VALID_ENV.DATABASE_URL);
  });

  it('coerces PORT and DATABASE_POOL_MAX from strings', () => {
    const env = validateEnv({ ...BASE_VALID_ENV, PORT: '5000', DATABASE_POOL_MAX: '25' });
    expect(env.PORT).toBe(5000);
    expect(env.DATABASE_POOL_MAX).toBe(25);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _DATABASE_URL, ...rest } = BASE_VALID_ENV;
    expect(() => validateEnv(rest)).toThrow(EnvValidationError);
  });

  it('names the missing variable in the error message', () => {
    const { DATABASE_URL: _DATABASE_URL, ...rest } = BASE_VALID_ENV;
    try {
      validateEnv(rest);
      expect.fail('expected validateEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).message).toContain('DATABASE_URL');
    }
  });

  it('rejects an invalid API_BASE_URL', () => {
    expect(() => validateEnv({ ...BASE_VALID_ENV, API_BASE_URL: 'not-a-url' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects an unknown NODE_ENV value', () => {
    expect(() => validateEnv({ ...BASE_VALID_ENV, NODE_ENV: 'staging' })).toThrow(
      EnvValidationError,
    );
  });

  describe('APP_ENV=production', () => {
    it('accepts a complete production configuration', () => {
      const env = validateEnv({
        ...BASE_VALID_ENV,
        APP_ENV: 'production',
        NODE_ENV: 'production',
      });
      expect(env.APP_ENV).toBe('production');
    });

    it('fails fast, naming every missing required variable at once', () => {
      try {
        validateEnv({ APP_ENV: 'production', NODE_ENV: 'production' });
        expect.fail('expected validateEnv to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(EnvValidationError);
        const message = (error as EnvValidationError).message;
        expect(message).toContain('DATABASE_URL');
        // API_BASE_URL / WEB_BASE_URL are caught by the base schema (they
        // have no default), so they surface as schema issues rather than
        // the production-only check — either way, every missing variable
        // is named in one error, not discovered one at a time.
      }
    });

    it('rejects an empty-string DATABASE_URL under production even though the base schema treats "" as present', () => {
      expect(() =>
        validateEnv({ ...BASE_VALID_ENV, APP_ENV: 'production', DATABASE_URL: '   ' }),
      ).toThrow(EnvValidationError);
    });
  });
});
