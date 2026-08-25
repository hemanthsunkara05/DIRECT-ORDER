import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { OrderStateModule } from '../orders/order-state.module.js';
import { CustomerRepository } from '../orders/repositories/customer.repository.js';
import { CustomerAccountGuard } from '../loyalty/guards/customer-account.guard.js';
import { STORAGE_PORT } from '../restaurants/uploads/storage.port.js';
import { S3StorageAdapter } from '../restaurants/uploads/s3-storage.adapter.js';
import { SupportCaseRepository } from './repositories/support-case.repository.js';
import { SupportMessageRepository } from './repositories/support-message.repository.js';
import { SupportAttachmentRepository } from './repositories/support-attachment.repository.js';
import { SupportAttachmentService } from './services/support-attachment.service.js';
import { SupportCaseService } from './services/support-case.service.js';
import { MeSupportController } from './controllers/me-support.controller.js';
import { RestaurantSupportController } from './controllers/restaurant-support.controller.js';
import { PublicSupportController } from './controllers/public-support.controller.js';

/**
 * Phase 17 (Support and analytics). `CustomerAccountGuard` (Phase 16,
 * `modules/loyalty/guards/`) is NOT exported from `LoyaltyModule` — it
 * was only ever consumed by that module's own `MeLoyaltyController`
 * before now — so it is re-provided here directly instead, alongside
 * its own dependency `CustomerRepository`, without importing
 * `LoyaltyModule` at all (this module needs nothing else from it). The
 * same "thin, stateless provider gets re-provided rather than pulling
 * in a whole other module" call this codebase already makes repeatedly
 * (`CustomerRepository` itself is already re-provided in four other
 * modules). `OrderStateModule` supplies `OrderRepository`
 * (`SupportCaseService` resolves/verifies an `orderNumber` against
 * it). `STORAGE_PORT` is re-provided too (`S3StorageAdapter`, same
 * registration `RestaurantsModule` uses) rather than importing
 * `RestaurantsModule`, which exports nothing today — `S3StorageAdapter`
 * is stateless (constructs its `S3Client` from env config alone, no
 * in-memory state a second instance could diverge on, unlike
 * `MockPaymentProvider`'s documented exception).
 */
@Module({
  imports: [IdentityModule, OrderStateModule],
  controllers: [MeSupportController, RestaurantSupportController, PublicSupportController],
  providers: [
    CustomerRepository,
    CustomerAccountGuard,
    SupportCaseRepository,
    SupportMessageRepository,
    SupportAttachmentRepository,
    SupportAttachmentService,
    SupportCaseService,
    { provide: STORAGE_PORT, useClass: S3StorageAdapter },
  ],
  exports: [SupportCaseRepository, SupportMessageRepository, SupportAttachmentService, SupportCaseService],
})
export class SupportModule {}
