import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import type { Env } from './config/env.schema.js';
import { ConfigModule } from './config/config.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { CorrelationMiddleware } from './logging/correlation.middleware.js';
import { ErrorsModule } from './errors/errors.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Aggregates every foundation-layer concern (config, logging, error
 * handling, database connectivity, health) into one module that
 * AppModule imports. Domain modules (restaurants, ordering, payments,
 * ...) added in later phases depend on this but never the reverse
 * (PRODUCT/docs/12-repository-structure.md — dependency direction).
 *
 * ConfigModule, LoggingModule, and DatabaseModule are each `@Global()`,
 * so importing them once here makes their providers (APP_CONFIG,
 * PINO_LOGGER, PrismaService, ...) injectable anywhere in the
 * application without every future domain module re-importing them.
 */
@Module({})
export class PlatformModule implements NestModule {
  static forRoot(env: Env) {
    return {
      module: PlatformModule,
      imports: [
        ConfigModule.forRoot(env),
        LoggingModule,
        ErrorsModule,
        DatabaseModule,
        HealthModule,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
