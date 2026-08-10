import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';

const MIN_PASSWORD_LENGTH = 10;

// A short list of the most common leaked passwords. Deliberately not
// exhaustive — a real deny-list (docs/09-security.md §15.2, "checked
// against a common-password list") is thousands of entries and belongs
// in a data file or an external service, not hardcoded here. This is
// enough to reject the most obvious cases without pretending to be a
// complete implementation.
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'letmein123',
  'iloveyou123',
  'welcome123',
  'admin1234',
]);

/**
 * The only place password hashing happens (docs/09-security.md §15.2).
 * argon2id, memory 64 MB (configurable via ARGON2_MEMORY_KB), iterations
 * 3, parallelism 4. No forced rotation, no character-composition rules —
 * both are documented as harming real-world password security more than
 * helping it; minimum length plus a common-password check is what
 * actually reduces risk.
 */
@Injectable()
export class PasswordService {
  constructor(@Inject(APP_CONFIG) private readonly env: Env) {}

  /**
   * Returns a list of policy violations, empty if the password is
   * acceptable. Never throws — callers decide how to surface issues
   * (e.g. as a 422 with field-level details).
   */
  validatePolicy(password: string): string[] {
    const issues: string[] = [];
    if (password.length < MIN_PASSWORD_LENGTH) {
      issues.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
      issues.push('This password is too common. Please choose a different one.');
    }
    return issues;
  }

  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: this.env.ARGON2_MEMORY_KB,
      timeCost: 3,
      parallelism: 4,
    });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // argon2.verify throws on a malformed hash rather than returning
      // false — treat that identically to "does not match" rather than
      // letting it propagate as a 500 on login.
      return false;
    }
  }
}
