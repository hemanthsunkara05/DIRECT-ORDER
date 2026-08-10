import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { CSRF_COOKIE } from '../../src/platform/security/csrf.js';
import { createCsrfCookieHook } from '../../src/platform/security/csrf-cookie.hook.js';
import type { Env } from '../../src/platform/config/env.schema.js';
import { PrismaService } from '../../src/platform/database/prisma.service.js';
import { RedisService } from '../../src/platform/redis/redis.service.js';
import { AuthNotifierService } from '../../src/modules/identity/services/auth-notifier.service.js';
import { STORAGE_PORT } from '../../src/modules/restaurants/uploads/storage.port.js';
import { createInMemoryPrisma, type InMemoryPrisma } from './in-memory-prisma.js';
import { createFakeRedisService } from './fake-redis.js';
import { FakeAuthNotifierService } from './fake-auth-notifier.js';
import { FakeStoragePort } from './fake-storage.js';

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
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_BUCKET: 'direct-order-test',
  STORAGE_ACCESS_KEY: 'test-access-key',
  STORAGE_SECRET_KEY: 'test-secret-key',
  STORAGE_REGION: 'us-east-1',
  CDN_BASE_URL: 'http://localhost:9000/direct-order-test',
  PLATFORM_FEE_BPS: 0,
  PAYMENT_PROVIDER: 'mock',
  ORDER_PAYMENT_TTL_MINUTES: 30,
  CART_TTL_HOURS: 24,
};

export interface TestApp {
  app: NestFastifyApplication;
  db: InMemoryPrisma;
  notifier: FakeAuthNotifierService;
  /** `Cookie:` header fragment carrying the CSRF token — merge into every mutating request's Cookie header. */
  csrfCookie: string;
  /** The raw token — set as the `X-CSRF-Token` header on every mutating request (docs/09-security.md §15.7). */
  csrfToken: string;
  storage: FakeStoragePort;
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
export async function createTestApp(
  envOverrides: Partial<Env> = {},
  // Lets a test register extra test-only controllers/modules (e.g. a
  // probe controller proving AuthorizationGuard's behaviour over real
  // HTTP) alongside the real app, without this helper needing to know
  // about them. `any[]` matches Nest's own `imports` array type
  // (DynamicModule | Type<any> | ...), which is this broad already.
  extraImports: any[] = [],
): Promise<TestApp> {
  const db = createInMemoryPrisma();
  const notifier = new FakeAuthNotifierService();
  const storage = new FakeStoragePort();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ ...TEST_ENV, ...envOverrides }), ...extraImports],
  })
    .overrideProvider(PrismaService)
    .useValue(db.prisma)
    .overrideProvider(RedisService)
    .useValue(createFakeRedisService())
    .overrideProvider(AuthNotifierService)
    .useValue(notifier)
    .overrideProvider(STORAGE_PORT)
    .useValue(storage)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ trustProxy: true }),
    // rawBody: true — same as main.ts — so WebhookController's raw-body
    // HMAC signature verification is exercised for real over HTTP here
    // too, not bypassed in tests.
    { logger: false, rawBody: true },
  );

  await app.register(fastifyCookie);
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', createCsrfCookieHook({ ...TEST_ENV, ...envOverrides }));
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // The onRequest hook sets a fresh CSRF cookie on any request that
  // doesn't already carry one — a plain GET is enough to obtain it, the
  // same way a browser gets one just by loading the page before ever
  // submitting a form.
  const probe = await request(app.getHttpServer()).get('/health');
  const setCookie = probe.headers['set-cookie'] as string[] | string | undefined;
  const rawCookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const csrfSetCookie = rawCookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
  if (!csrfSetCookie) {
    throw new Error('The CSRF cookie hook did not set a cookie on the probe request.');
  }
  const csrfCookie = csrfSetCookie.split(';')[0]!;
  const csrfToken = csrfCookie.slice(`${CSRF_COOKIE}=`.length);

  return { app, db, notifier, csrfCookie, csrfToken, storage };
}
