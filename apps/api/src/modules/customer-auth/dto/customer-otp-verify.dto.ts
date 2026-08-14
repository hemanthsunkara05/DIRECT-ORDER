import { z } from 'zod';

/**
 * `fullName` is only actually used the first time this phone completes
 * verification (a brand-new account) — an existing account's `User.
 * fullName` is never overwritten by a later login's `fullName`, even if
 * the client sends a different value. `referralCode` (BR-110) is
 * likewise only meaningful on that same first-ever verification; a
 * returning customer's `referralCode` is ignored (BR-108: at most one
 * referrer, ever).
 */
export const CustomerOtpVerifyDto = z.object({
  phone: z.string().trim().min(6).max(20),
  code: z.string().trim().min(4).max(64),
  fullName: z.string().trim().min(1).max(200).optional(),
  referralCode: z.string().trim().min(1).max(50).optional(),
});

export type CustomerOtpVerifyInput = z.infer<typeof CustomerOtpVerifyDto>;
