import { createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(base32: string): Buffer {
  const clean = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * RFC 6238 (TOTP) over RFC 4226 (HOTP), implemented directly against
 * `node:crypto` rather than pulling in a third-party TOTP package — the
 * algorithm is genuinely small (HMAC-SHA1 + dynamic truncation) and
 * this keeps the security-critical MFA code path fully auditable in one
 * file, the same "bespoke, auditable adapter costs less than an
 * unverifiable dependency" reasoning this codebase already applies to
 * `RazorpayPaymentProvider`/`UberDirectProvider`. Verified against
 * known RFC 6238 test vectors in `totp.service.test.ts`.
 */
@Injectable()
export class TotpService {
  /** A fresh, random 160-bit secret (base32-encoded, the format every authenticator app expects). */
  generateSecret(): string {
    return base32Encode(randomBytes(20));
  }

  /** `otpauth://` URI for a QR code — never logged, only ever shown once during enrollment. */
  buildOtpAuthUri(secretBase32: string, accountLabel: string, issuer = 'Direct-Order'): string {
    const label = encodeURIComponent(`${issuer}:${accountLabel}`);
    return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
  }

  /** The current 6-digit code for a secret — the counterpart to `verify()`. Production code never calls this (the server verifies a code the AUTHENTICATOR APP generated, it never generates one itself); it exists for tests and any future "show your current code" debug view. */
  generate(secretBase32: string, at: Date = new Date()): string {
    const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
    return this.hotp(secretBase32, counter);
  }

  private hotp(secretBase32: string, counter: number): string {
    const key = base32Decode(secretBase32);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const hmac = createHmac('sha1', key).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1]! & 0xf;
    const binCode =
      ((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff);
    return String(binCode % 10 ** DIGITS).padStart(DIGITS, '0');
  }

  /** `window` steps of tolerance each direction (±30s by default) for clock drift between server and authenticator app. */
  verify(secretBase32: string, token: string, at: Date = new Date(), window = 1): boolean {
    if (!/^\d{6}$/.test(token)) return false;
    const counter = Math.floor(at.getTime() / 1000 / STEP_SECONDS);
    for (let i = -window; i <= window; i++) {
      if (this.hotp(secretBase32, counter + i) === token) return true;
    }
    return false;
  }
}
