import { z } from 'zod';

/**
 * Scoped to EMAIL_VERIFICATION / PHONE_VERIFICATION only — PASSWORD_RESET
 * has its own endpoint (/auth/password/forgot) because that flow is
 * enumeration-resistant by design (always 200, never reveals whether the
 * account exists), which is a different contract than "send me a code
 * for this identifier."
 */
export const OtpRequestDto = z.object({
  identifier: z.string().trim().min(1).max(320),
  purpose: z.enum(['EMAIL_VERIFICATION', 'PHONE_VERIFICATION']),
});

export type OtpRequestInput = z.infer<typeof OtpRequestDto>;
