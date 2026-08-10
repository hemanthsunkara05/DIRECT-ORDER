import { Global, Module } from '@nestjs/common';
import { OutboxRepository } from './outbox.repository.js';
import { OutboxService } from './outbox.service.js';

/**
 * `@Global()`, like ConfigModule/LoggingModule/DatabaseModule/AuditModule
 * in platform.module.ts — OutboxService is a cross-cutting concern every
 * state-changing domain service (OrderStateService, WebhookService,
 * RefundService, ...) needs, not something scoped to one module.
 */
@Global()
@Module({
  providers: [OutboxRepository, OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
