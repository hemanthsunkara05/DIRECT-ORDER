import type request from 'supertest';
import type { TestApp } from './create-test-app.js';
import { mutate } from './register-and-login.js';

export interface RegisteredCustomer {
  userId: string;
  customerId: string;
  phone: string;
  cookie: string;
  referralApplied: boolean;
}

function rawSetCookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'] as string[] | string | undefined;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Full request → verify OTP flow via real HTTP for AMB-2's "lightweight
 * optional account" (Phase 16) — the customer-side counterpart to
 * `registerAndLogin` (staff/admin). Reads the raw OTP code out of
 * `ctx.notifier.customerLoginCodes`, same technique
 * `registerAndLogin` already uses for email verification codes.
 */
export async function registerAndLoginCustomer(
  ctx: TestApp,
  phone: string,
  overrides: { fullName?: string; referralCode?: string } = {},
): Promise<RegisteredCustomer> {
  await mutate(ctx, 'post', '/api/v1/auth/customer/otp/request')
    .send({ phone })
    .expect(200);

  const code = ctx.notifier.customerLoginCodes.get(phone);
  if (!code) throw new Error('customer login code was not captured by the fake notifier');

  const verifyRes = await mutate(ctx, 'post', '/api/v1/auth/customer/otp/verify')
    .send({
      phone,
      code,
      ...(overrides.fullName ? { fullName: overrides.fullName } : {}),
      ...(overrides.referralCode ? { referralCode: overrides.referralCode } : {}),
    })
    .expect(200);

  const userId = ctx.db.users.find((u) => u.phone === phone)!.id;
  const customerId = ctx.db.customers.find((c) => c.userId === userId)!.id;
  const cookie = rawSetCookies(verifyRes)
    .map((c) => c.split(';')[0])
    .join('; ');

  return {
    userId,
    customerId,
    phone,
    cookie,
    referralApplied: verifyRes.body.data.referralApplied as boolean,
  };
}
