import { Inject, Injectable } from '@nestjs/common';
import type { Customer, User } from '@prisma/client';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { UserRepository } from '../../identity/repositories/user.repository.js';
import { OtpService } from '../../identity/services/otp.service.js';
import { SessionService, type SessionContext, type IssuedSession } from '../../identity/services/session.service.js';
import { TokenService } from '../../identity/services/token.service.js';
import { AuthNotifierService } from '../../identity/services/auth-notifier.service.js';
import { CustomerRepository } from '../../orders/repositories/customer.repository.js';
import { LoyaltyAccountRepository } from '../../loyalty/repositories/loyalty-account.repository.js';
import { ReferralService } from '../../loyalty/services/referral.service.js';

export type CustomerOtpVerifyResult =
  | {
      outcome: 'VERIFIED';
      user: User;
      customer: Customer;
      issued: IssuedSession;
      accessToken: string;
      referralApplied: boolean;
    }
  | { outcome: 'INVALID' | 'EXPIRED' | 'TOO_MANY_ATTEMPTS' };

/**
 * AMB-2's "lightweight optional account" (phone-OTP, no password) —
 * assembles the SAME request-a-code/verify-a-code/issue-a-session
 * pieces `AuthService` uses for staff (`OtpService`, `SessionService`,
 * `TokenService`), just for customers instead of `User` rows that back
 * restaurant/admin roles. Deliberately its own service rather than a
 * branch inside `AuthService`: the two flows share infrastructure, not
 * behaviour (no password, no email verification step, a Customer row
 * and LoyaltyAccount are created alongside the User, and a referral
 * code may be resolved at signup) — mixing them into one service would
 * make `AuthService` harder to reason about for no real benefit.
 */
@Injectable()
export class CustomerAuthService {
  constructor(
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(CustomerRepository) private readonly customers: CustomerRepository,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(LoyaltyAccountRepository) private readonly loyaltyAccounts: LoyaltyAccountRepository,
    @Inject(ReferralService) private readonly referrals: ReferralService,
    @Inject(AuthNotifierService) private readonly notifier: AuthNotifierService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Not enumeration-resistant by design, same reasoning as
   * `AuthService.requestVerification` — unlike login/registration/
   * password-reset, whether a phone already has an account is not
   * sensitive here: EVERY phone can receive a code and either log in
   * (existing account) or sign up (new account) with it, so there is
   * no "does this account exist" fact for a response shape to leak.
   */
  async requestOtp(phone: string): Promise<void> {
    const issued = await this.otp.request(phone, 'CUSTOMER_LOGIN');
    this.notifier.notifyCustomerLoginCode(phone, issued.secret);
  }

  async verifyOtp(
    phone: string,
    code: string,
    input: { fullName?: string; referralCode?: string },
    context: SessionContext = {},
  ): Promise<CustomerOtpVerifyResult> {
    const result = await this.otp.verify(phone, 'CUSTOMER_LOGIN', code);
    if (result !== 'VERIFIED') {
      return { outcome: result };
    }

    let user = await this.users.findByPhone(phone);
    let isNewAccount = false;
    if (!user) {
      user = await this.users.createCustomerAccount({
        phone,
        fullName: input.fullName ?? 'Customer',
      });
      isNewAccount = true;
    }

    let customer = await this.customers.findByUserId(user.id);
    let referralApplied = false;
    if (!customer) {
      customer = await this.customers.createAccount({
        userId: user.id,
        fullName: user.fullName,
        phone: user.phone!,
      });
      await this.loyaltyAccounts.create(customer.id);
      isNewAccount = true;
      referralApplied = await this.referrals.attributeAtSignup(customer.id, input.referralCode);
    }

    const issued = await this.sessions.createSession(user.id, context);
    await this.users.recordLogin(user.id);
    const accessToken = this.tokens.signAccessToken(user.id, issued.session.id);

    await this.audit.record({
      actorType: 'CUSTOMER',
      actorId: customer.id,
      action: isNewAccount ? 'CUSTOMER_ACCOUNT_CREATED' : 'CUSTOMER_LOGIN',
      entityType: 'Customer',
      entityId: customer.id,
    });

    return { outcome: 'VERIFIED', user, customer, issued, accessToken, referralApplied };
  }
}
