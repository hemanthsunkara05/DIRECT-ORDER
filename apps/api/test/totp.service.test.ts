import { describe, expect, it } from 'vitest';
import { TotpService } from '../src/modules/identity/services/totp.service.js';

/**
 * RFC 6238 Appendix B's own SHA1 test vectors (secret ASCII
 * "12345678901234567890", 20 bytes) — the RFC's vectors are 8-digit;
 * this codebase's `TotpService` truncates to the standard 6-digit
 * length every authenticator app uses. The last 6 digits of an 8-digit
 * HOTP value are identical to a direct 6-digit computation (both are
 * `binCode % 10^n`, and `10^6` divides `10^8`), so slicing the RFC's
 * published 8-digit values to their last 6 digits is a faithful,
 * traceable-to-the-spec expected value, not an invented one.
 */
function base32Encode(ascii: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const buffer = Buffer.from(ascii, 'ascii');
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

describe('TotpService', () => {
  const totp = new TotpService();
  const secret = base32Encode('12345678901234567890');

  const vectors: [number, string][] = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ];

  it.each(vectors)(
    "matches RFC 6238's test vector at unix time %d",
    (unixSeconds, expected6Digit) => {
      const at = new Date(unixSeconds * 1000);
      expect(totp.verify(secret, expected6Digit, at, 0)).toBe(true);
    },
  );

  it('rejects a code from well outside the tolerance window', () => {
    const at = new Date(59 * 1000);
    expect(totp.verify(secret, '287082', new Date((59 + 3600) * 1000), 1)).toBe(false);
    void at;
  });

  it('accepts a code one step early/late within the default window', () => {
    // 1111111109 -> '081804'; one step (30s) later is still within window=1.
    const oneStepLater = new Date((1111111109 + 30) * 1000);
    expect(totp.verify(secret, '081804', oneStepLater, 1)).toBe(true);
  });

  it('rejects a malformed token', () => {
    expect(totp.verify(secret, 'abcdef', new Date(59 * 1000))).toBe(false);
    expect(totp.verify(secret, '12345', new Date(59 * 1000))).toBe(false);
  });

  it('generateSecret produces a usable base32 secret, and buildOtpAuthUri embeds it correctly', () => {
    const generated = totp.generateSecret();
    expect(/^[A-Z2-7]+$/.test(generated)).toBe(true);
    const uri = totp.buildOtpAuthUri(generated, 'owner@spiceroute.test');
    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(`secret=${generated}`);
  });
});
