import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { CustomerRepository } from '../orders/repositories/customer.repository.js';
import { CustomerAuthService } from './services/customer-auth.service.js';
import { CustomerAuthController } from './controllers/customer-auth.controller.js';

/**
 * Phase 16. Imports `IdentityModule` (OTP/session/token machinery) and
 * `LoyaltyModule` (a brand-new account needs a `LoyaltyAccount` row
 * created alongside it, and a `referralCode` at signup is resolved via
 * `ReferralService.attributeAtSignup`) — `LoyaltyModule` does not
 * import this module back, so there is no cycle. `CustomerRepository`
 * is re-provided directly, same established call every other module
 * needing it makes.
 */
@Module({
  imports: [IdentityModule, LoyaltyModule],
  controllers: [CustomerAuthController],
  providers: [CustomerRepository, CustomerAuthService],
})
export class CustomerAuthModule {}
