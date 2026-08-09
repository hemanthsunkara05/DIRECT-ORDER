import { Global, Module } from '@nestjs/common';
import type { Env } from '../config/env.schema.js';
import { APP_CONFIG } from '../config/config.module.js';
import { createLogger } from './logger.js';
import { AppLoggerService } from './logger.service.js';
import { PINO_LOGGER } from './logging.tokens.js';
import { CorrelationMiddleware } from './correlation.middleware.js';

@Global()
@Module({
  providers: [
    {
      provide: PINO_LOGGER,
      inject: [APP_CONFIG],
      useFactory: (env: Env) => createLogger(env.LOG_LEVEL),
    },
    AppLoggerService,
    CorrelationMiddleware,
  ],
  exports: [PINO_LOGGER, AppLoggerService, CorrelationMiddleware],
})
export class LoggingModule {}
