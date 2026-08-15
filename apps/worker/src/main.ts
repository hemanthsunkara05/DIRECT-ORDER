import pino from 'pino';
import { validateWorkerEnv, WorkerEnvValidationError } from './env.schema.js';
import { initSentry, captureException } from './sentry.js';

/**
 * Worker process entrypoint. Phase 1 registers no job processors — this
 * proves the process boots, logs structurally, and shuts down
 * gracefully. Real consumers (notification delivery, delivery dispatch,
 * loyalty grants, analytics rollups, ...) attach here starting Phase 12
 * (PRODUCT/docs/07-events-and-jobs.md, PRODUCT/docs/13-implementation-phases.md).
 */
function loadEnvOrExit() {
  try {
    return validateWorkerEnv(process.env);
  } catch (error) {
    if (error instanceof WorkerEnvValidationError) {
      console.error(error.message);
    } else {
      console.error('Failed to load worker environment configuration:', error);
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const env = loadEnvOrExit();
  initSentry(env);
  const logger = pino({ level: env.LOG_LEVEL, timestamp: pino.stdTimeFunctions.isoTime });

  logger.info({ appEnv: env.APP_ENV }, 'Worker starting (no job processors registered — Phase 1)');

  let shuttingDown = false;
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({ signal }, 'Received shutdown signal, stopping worker');
        resolve();
      });
    }
  });

  logger.info('Worker stopped');
}

main().catch((error: unknown) => {
  console.error('Fatal error in worker:', error);
  captureException(error);
  process.exit(1);
});
