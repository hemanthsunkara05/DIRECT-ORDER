import { Module } from '@nestjs/common';
import { LoyaltyModule } from '../loyalty/loyalty.module.js';
import { ReconciliationIssueRepository } from '../payments/repositories/reconciliation-issue.repository.js';
import { DataIntegrityService } from './services/data-integrity.service.js';

/**
 * Phase 19. `ReconciliationIssueRepository` is re-provided directly
 * here rather than importing all of `PaymentsModule` for it — the
 * same "thin, stateless provider gets re-provided" convention this
 * codebase already applies repeatedly (`CustomerRepository`,
 * `STORAGE_PORT`) — `PaymentsModule` doesn't currently export it and
 * this module needs nothing else from `PaymentsModule`.
 * `LoyaltyReconciliationService` (one of `DataIntegrityService`'s six
 * checks) IS already exported by `LoyaltyModule`, so that one's a
 * normal import.
 */
@Module({
  imports: [LoyaltyModule],
  providers: [ReconciliationIssueRepository, DataIntegrityService],
  exports: [DataIntegrityService],
})
export class DataIntegrityModule {}
