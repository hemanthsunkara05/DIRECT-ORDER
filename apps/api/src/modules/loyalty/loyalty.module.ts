import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { OrderStateModule } from '../orders/order-state.module.js';
import { CustomerRepository } from '../orders/repositories/customer.repository.js';
import { LoyaltyAccountRepository } from './repositories/loyalty-account.repository.js';
import { LoyaltyLedgerRepository } from './repositories/loyalty-ledger.repository.js';
import { LoyaltyRedemptionRepository } from './repositories/loyalty-redemption.repository.js';
import { ReferralRepository } from './repositories/referral.repository.js';
import { LoyaltyEarnService } from './services/loyalty-earn.service.js';
import { LoyaltyRedemptionService } from './services/loyalty-redemption.service.js';
import { LoyaltyClawbackService } from './services/loyalty-clawback.service.js';
import { ReferralService } from './services/referral.service.js';
import { LoyaltyOutboxConsumer } from './services/loyalty-outbox-consumer.service.js';
import { LoyaltyReconciliationService } from './services/loyalty-reconciliation.service.js';
import { CustomerAccountGuard } from './guards/customer-account.guard.js';
import { MeLoyaltyController } from './controllers/me-loyalty.controller.js';

/**
 * Phase 16 (Loyalty and referrals). Imports `OrderStateModule` for
 * `OrderRepository` (`LoyaltyOutboxConsumer` re-reads order context
 * from an event rather than trusting the payload alone, same reasoning
 * as `NotificationCatalogue` — see that class's own doc comment) and
 * `IdentityModule` for `AuthGuard` (`/me/loyalty*`, `/me/referrals`).
 * `CustomerRepository` is re-provided directly rather than imported
 * from `OrdersModule` — the established "thin, stateless,
 * PrismaService-backed" call, see that class's own doc comment.
 *
 * `LoyaltyOutboxConsumer`/`LoyaltyReconciliationService` register
 * themselves in their own `onModuleInit()` (the outbox relay, a
 * `setInterval` timer respectively) — listed as providers but never
 * injected anywhere, the same self-starting shape `OutboxService`/
 * `OrderExpiryScheduler` already use.
 *
 * Exports everything `CustomerAuthModule` (account creation + referral
 * attribution at signup) and `OrdersModule` (`CheckoutService`'s
 * redemption reservation) need directly, plus `AdminModule`'s admin
 * loyalty controller — no other module needs to reach into this one's
 * internals beyond these.
 */
@Module({
  imports: [IdentityModule, OrderStateModule],
  controllers: [MeLoyaltyController],
  providers: [
    CustomerRepository,
    LoyaltyAccountRepository,
    LoyaltyLedgerRepository,
    LoyaltyRedemptionRepository,
    ReferralRepository,
    LoyaltyEarnService,
    LoyaltyRedemptionService,
    LoyaltyClawbackService,
    ReferralService,
    LoyaltyOutboxConsumer,
    LoyaltyReconciliationService,
    CustomerAccountGuard,
  ],
  exports: [
    LoyaltyAccountRepository,
    LoyaltyLedgerRepository,
    LoyaltyRedemptionRepository,
    ReferralRepository,
    LoyaltyRedemptionService,
    ReferralService,
    LoyaltyReconciliationService,
  ],
})
export class LoyaltyModule {}
