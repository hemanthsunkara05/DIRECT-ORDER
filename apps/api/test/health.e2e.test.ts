import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/platform/database/prisma.service.js';
import type { Env } from '../src/platform/config/env.schema.js';

/**
 * A real Nest + Fastify application, boots exactly the way main.ts
 * boots it, exercised over real HTTP via supertest. PrismaService is
 * the one thing overridden — with a controllable stub rather than a
 * live PostgreSQL connection, because this sandbox has no Docker
 * available (see the Phase 1 report's VALIDATION section for what a
 * real `docker compose up -d` + live-Postgres run still needs to
 * verify). Every other line of this test hits real application code:
 * real routing, the real CorrelationMiddleware, the real
 * GlobalExceptionFilter, the real health/ready controller logic.
 */

const TEST_ENV: Env = {
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
  ARGON2_MEMORY_KB: 65536,
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_BUCKET: 'direct-order-test',
  STORAGE_ACCESS_KEY: 'test-access-key',
  STORAGE_SECRET_KEY: 'test-secret-key',
  STORAGE_REGION: 'us-east-1',
  CDN_BASE_URL: 'http://localhost:9000/direct-order-test',
};

class ControllablePrismaStub {
  private shouldFail = false;

  fail(): void {
    this.shouldFail = true;
  }

  succeed(): void {
    this.shouldFail = false;
  }

  ping(): Promise<void> {
    if (this.shouldFail) {
      return Promise.reject(new Error('connection refused'));
    }
    return Promise.resolve();
  }
}

describe('Foundation HTTP surface (e2e)', () => {
  let app: NestFastifyApplication;
  let prismaStub: ControllablePrismaStub;

  beforeAll(async () => {
    prismaStub = new ControllablePrismaStub();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(TEST_ENV)],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('returns 200 when the database is reachable', async () => {
      prismaStub.succeed();
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('returns 200 even when the database is unreachable — liveness ignores dependencies', async () => {
      prismaStub.fail();
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      prismaStub.succeed();
    });
  });

  describe('GET /ready', () => {
    it('returns 200 with checks.database.status=ok when the database is reachable', async () => {
      prismaStub.succeed();
      const res = await request(app.getHttpServer()).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.checks.database.status).toBe('ok');
      expect(typeof res.body.checks.database.latencyMs).toBe('number');
    });

    it('returns 503 with checks.database.status=error when the database is unreachable', async () => {
      prismaStub.fail();
      const res = await request(app.getHttpServer()).get('/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.checks.database.status).toBe('error');
      expect(res.body.checks.database.error).toContain('connection refused');
      prismaStub.succeed();
    });
  });

  describe('correlation IDs', () => {
    it('sets an x-request-id response header even when the client sends none', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['x-request-id']).toBeTruthy();
    });

    it('echoes back a client-supplied x-request-id', async () => {
      const res = await request(app.getHttpServer())
        .get('/health')
        .set('x-request-id', 'my-custom-trace-id');
      expect(res.headers['x-request-id']).toBe('my-custom-trace-id');
    });

    it('issues a different request ID for each request', async () => {
      const [a, b] = await Promise.all([
        request(app.getHttpServer()).get('/health'),
        request(app.getHttpServer()).get('/health'),
      ]);
      expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    });
  });

  describe('malformed / unmatched requests → standard error envelope', () => {
    it('an unknown route returns the standard error envelope with code, message, requestId', async () => {
      const res = await request(app.getHttpServer()).get('/this-route-does-not-exist');

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: {
          code: 'NOT_FOUND',
          message: expect.any(String),
          requestId: expect.any(String),
        },
      });
    });

    it('the envelope requestId matches the x-request-id response header for the same request', async () => {
      const res = await request(app.getHttpServer())
        .get('/also-not-a-real-route')
        .set('x-request-id', 'trace-for-404');

      expect(res.headers['x-request-id']).toBe('trace-for-404');
      expect(res.body.error.requestId).toBe('trace-for-404');
    });

    it('an unsupported method on a real route returns the standard envelope, not a raw framework error', async () => {
      const res = await request(app.getHttpServer()).post('/health');

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toEqual(expect.any(String));
      expect(res.body.error.requestId).toEqual(expect.any(String));
    });
  });
});
