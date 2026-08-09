import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import type { Logger } from 'pino';
import { PINO_LOGGER } from './logging.tokens.js';

/**
 * Adapts our pino logger to NestJS's LoggerService interface so
 * `app.useLogger(...)` and framework-internal logging (bootstrap
 * messages, route registration) also emit structured JSON with
 * correlation IDs, rather than NestJS's default colourised console
 * output.
 */
@Injectable()
export class AppLoggerService implements LoggerService {
  constructor(@Inject(PINO_LOGGER) private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, this.stringify(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, this.stringify(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, this.stringify(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, this.stringify(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, this.stringify(message));
  }

  private stringify(message: unknown): string {
    return typeof message === 'string' ? message : JSON.stringify(message);
  }
}
