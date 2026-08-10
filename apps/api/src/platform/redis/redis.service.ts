import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Env } from '../config/env.schema.js';
import { APP_CONFIG } from '../config/config.module.js';
import { PINO_LOGGER } from '../logging/logging.tokens.js';

/**
 * The only Redis client instance in the process — rate limiting (Phase 3)
 * and, from Phase 12, job queues and caching all go through this.
 *
 * Unlike PrismaService (Phase 1: eager $connect() crashed the whole
 * bootstrap on an unreachable database), ioredis connects in the
 * background by default and does not throw at construction time — so
 * there is no equivalent eager-connect bug to avoid here. What DOES
 * matter: an ioredis client with no 'error' listener attached turns a
 * connection failure into an unhandled 'error' event, which Node treats
 * as an uncaught exception and crashes the process anyway. The listener
 * below exists specifically to prevent that.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(
    @Inject(APP_CONFIG) env: Env,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {
    this.client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
      lazyConnect: false,
    });

    this.client.on('error', (err: Error) => {
      this.logger.error({ err: err.message }, 'Redis client error');
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
