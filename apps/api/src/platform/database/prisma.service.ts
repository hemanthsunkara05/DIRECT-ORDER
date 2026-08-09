import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import type { Env } from '../config/env.schema.js';
import { APP_CONFIG } from '../config/config.module.js';
import { PINO_LOGGER } from '../logging/logging.tokens.js';

/**
 * The only Prisma client instance in the process. Every repository in
 * every domain module injects this service rather than constructing
 * its own `new PrismaClient()` — connection pooling, lifecycle, and
 * graceful shutdown are handled once, here.
 *
 * `prisma/schema.prisma` has no models yet (Phase 1 is foundation
 * only — domain tables arrive in Phase 2). The client is still fully
 * functional for `$connect`/`$queryRaw`, which is exactly what the
 * `/ready` endpoint needs.
 *
 * Deliberately does NOT eagerly `$connect()` in a lifecycle hook.
 * Prisma connects lazily on first query by design; calling `$connect()`
 * during `onModuleInit` throws — and crashes the entire Nest bootstrap,
 * before `app.listen()` ever runs — if the database happens to be
 * unreachable at process startup. That would mean a database blip
 * prevents `/health` from ever becoming available at all, which is the
 * exact failure mode liveness/readiness separation exists to prevent
 * (verified manually: booting the compiled build against a deliberately
 * unreachable Postgres killed the process with an unhandled
 * PrismaClientInitializationError before it ever bound to a port). The
 * first real connection attempt now happens inside `ping()`, called
 * only from `/ready`, which is exactly where an unreachable database
 * should be reported — as "not ready", not as a crashed process.
 */
@Injectable()
// Prisma's `$on('warn'|'error', ...)` overloads are keyed off the
// client's second generic parameter, not inferred from the `log`
// array passed to `super()` — extending PrismaClient without it
// resolves `$on`'s event name to `never`. Must list every level
// configured with `emit: 'event'` below.
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, 'warn' | 'error'>
  implements OnModuleDestroy
{
  constructor(
    @Inject(APP_CONFIG) env: Env,
    @Inject(PINO_LOGGER) private readonly logger: Logger,
  ) {
    super({
      datasources: { db: { url: env.DATABASE_URL } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    this.$on('warn', (event) => {
      this.logger.warn({ target: event.target }, event.message);
    });
    this.$on('error', (event) => {
      this.logger.error({ target: event.target }, event.message);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Used exclusively by the readiness check. A successful round trip
   * proves the connection pool can reach the database right now; it is
   * never used to gate liveness (PRODUCT/docs/10-infrastructure-deployment.md §17.5).
   */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}
