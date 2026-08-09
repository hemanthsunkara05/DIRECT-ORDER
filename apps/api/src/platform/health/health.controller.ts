import { Controller, Get, HttpCode, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { HealthResponse, ReadinessCheck, ReadyResponse } from '@direct-order/contracts';
import { PrismaService } from '../database/prisma.service.js';

/**
 * Liveness and readiness, kept deliberately distinct
 * (PRODUCT/docs/10-infrastructure-deployment.md §17.5, Phase 1
 * acceptance criteria):
 *
 * - /health answers "is this process alive?" and checks NOTHING else.
 *   A database blip must never cause a liveness failure and a restart
 *   loop.
 * - /ready answers "can this instance safely receive traffic?" and
 *   reflects real dependency state. It gates whether the deployment
 *   platform routes requests to this instance.
 */
@Controller()
export class HealthController {
  // Explicit @Inject(PrismaService) rather than relying on implicit
  // constructor-parameter-type DI: esbuild (used by both `tsx` in
  // development and Vitest in tests) does not reliably emit the
  // `design:paramtypes` decorator metadata Nest needs to infer the
  // token from the TypeScript type alone. Without this, the real
  // `tsc`-compiled production build would work while `pnpm dev` and
  // every test silently injected `undefined`. See
  // PRODUCT/docs/12-repository-structure.md §19.5.
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('health')
  @HttpCode(200)
  health(): HealthResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: false }) reply: FastifyReply): Promise<void> {
    const database = await this.checkDatabase();
    const status: ReadyResponse['status'] = database.status === 'ok' ? 'ready' : 'not_ready';
    const body: ReadyResponse = { status, checks: { database } };

    reply.code(status === 'ready' ? 200 : 503).send(body);
  }

  private async checkDatabase(): Promise<ReadinessCheck> {
    const start = performance.now();
    try {
      await this.prisma.ping();
      // eslint-disable-next-line no-restricted-syntax -- not money: rounding a latency measurement (ms) for display
      const latencyMs = Math.round(performance.now() - start);
      return { status: 'ok', latencyMs };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : 'Unknown database error',
      };
    }
  }
}
