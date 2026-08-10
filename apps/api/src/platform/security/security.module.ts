import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CsrfGuard } from './csrf.guard.js';

/**
 * CSRF protection (docs/09-security.md §15.7). `CsrfGuard` is safe to
 * register globally, unlike AuthorizationGuard — it never depends on
 * `request.user` or any other guard having run first, so ordering
 * relative to AuthGuard/AuthorizationGuard doesn't matter.
 *
 * The CSRF-cookie-issuing half lives outside Nest entirely
 * (csrf-cookie.hook.ts, registered directly as a Fastify `onRequest`
 * hook in main.ts / the test harness) — see that file's doc comment
 * for why it is deliberately not a NestMiddleware.
 */
@Module({
  providers: [{ provide: APP_GUARD, useClass: CsrfGuard }],
})
export class SecurityModule {}
