import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from '../../src/app.module.js';
import type { Env } from '../../src/platform/config/env.schema.js';
import { PrismaService } from '../../src/platform/database/prisma.service.js';
import { RedisService } from '../../src/platform/redis/redis.service.js';
import { AuthNotifierService } from '../../src/modules/identity/services/auth-notifier.service.js';
import { createInMemoryPrisma, type InMemoryPrisma } from './in-memory-prisma.js';
import { createFakeRedisService } from './fake-redis.js';
import { FakeAuthNotifierService } from './fake-auth-notifier.js';

export const TEST_ENV: Env = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  PORT: 0,
  API_BASE_URL: 'http://localhost:4000',
  WEB_BASE_URL: 'http://localhost:3000',
  LOG_LEVEL: 'silent',
  APP_DATABASE_URL: 'postgresql://direct_order_app:test@localhost:5432/direct_order_test',
  DATABASE_POOL_MAX: 5,
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-only-secret-at-least-32-characters-long',
  JWT_ACCESS_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_DAYS: 30,
  ARGON2_MEMORY_KB: 8192, // small: correctness doesn't depend on cost, and this keeps the suite fast
};

export interface TestApp {
  app: NestFastifyApplication;
  db: InMemoryPrisma;
  notifier: FakeAuthNotifierService;
}

/**
 * Boots the real AppModule — same wiring as main.ts — with only the
 * database and Redis faked (in-memory) and the auth notifier replaced by
 * a capturing fake instead of the console-log placeholder, so tests can
 * read the OTP code / reset token a "sent" message would have carried.
 * Everything else (routing, guards, DTOs, services, the exception
 * filter, cookie handling) is the real Phase 3 code, exercised over real
 * HTTP via supertest — a fresh instance per test keeps rate-limit
 * counters and DB state from leaking between test cases.
 */
export async function createTestApp(envOverrides: Partial<Env> = {}): Promise<TestApp> {
  const db = createInMemoryPrisma();
  const notifier = new FakeAuthNotifierService();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ ...TEST_ENV, ...envOverrides })],
  })
    .overrideProvider(PrismaService)
    .useValue(db.prisma)
    .overrideProvider(RedisService)
    .useValue(createFakeRedisService())
    .overrideProvider(AuthNotifierService)
    .useValue(notifier)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ trustProxy: true }),
    { logger: false },
  );

  await app.register(fastifyCookie);
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return { app, db, notifier };
}
