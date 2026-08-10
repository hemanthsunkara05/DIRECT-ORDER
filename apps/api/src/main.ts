import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import { AppModule } from './app.module.js';
import { validateEnv, EnvValidationError, type Env } from './platform/config/env.schema.js';
import { AppLoggerService } from './platform/logging/logger.service.js';

/**
 * Validated BEFORE the Nest DI container is even constructed. A
 * production deploy missing a required variable fails here, with the
 * variable named, instead of surfacing as an obscure error partway
 * through bootstrap or — worse — at the first request that needs it
 * (Phase 1 acceptance criteria, PRODUCT/docs/16-execution-protocol.md §24.4).
 */
function loadEnvOrExit(): Env {
  try {
    return validateEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
    } else {
      console.error('Failed to load environment configuration:', error);
    }
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  const env = loadEnvOrExit();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env),
    new FastifyAdapter({ trustProxy: true }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(AppLoggerService));

  await app.register(fastifyCookie);
  // credentials:true + an explicit origin (not '*') is required for the
  // browser to actually send the HttpOnly session cookies cross-origin
  // between the web app's and the API's domains (docs/09-security.md §15.7).
  await app.register(fastifyCors, { origin: env.WEB_BASE_URL, credentials: true });

  // /health and /ready are infrastructure liveness/readiness probes, not
  // part of the versioned public API — excluded from the prefix so a
  // load balancer can hit them at a fixed, version-independent path.
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });

  registerGracefulShutdown(app);

  await app.listen(env.PORT, '0.0.0.0');
  app.get(AppLoggerService).log(`API listening on port ${env.PORT} (${env.APP_ENV})`, 'Bootstrap');
}

/**
 * Stops accepting new connections and lets Nest run every module's
 * OnModuleDestroy hook (notably PrismaService disconnecting cleanly)
 * before the process exits, rather than terminating mid-operation
 * (PRODUCT/docs/10-infrastructure-deployment.md §17.5). There are no
 * background jobs or in-flight financial operations to drain in Phase
 * 1 — that concern applies to apps/worker once it has real jobs.
 */
function registerGracefulShutdown(app: NestFastifyApplication): void {
  const logger = app.get(AppLoggerService);

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      logger.log(`Received ${signal}, shutting down gracefully`, 'Shutdown');
      app
        .close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          logger.error(
            'Error during shutdown',
            error instanceof Error ? error.stack : undefined,
            'Shutdown',
          );
          process.exit(1);
        });
    });
  }
}

bootstrap().catch((error: unknown) => {
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
