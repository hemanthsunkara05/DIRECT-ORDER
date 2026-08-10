import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Env } from '../config/env.schema.js';
import { CSRF_COOKIE, generateCsrfToken } from './csrf.js';

/**
 * A native Fastify `onRequest` hook, not a NestMiddleware — deliberately.
 * NestJS's Fastify adapter runs `NestMiddleware` classes through
 * `@fastify/middie` (an Express-compatibility shim), and chaining a
 * second middleware there (`consumer.apply(A, B)`) produced a real,
 * reproducible bug during Phase 5 development: reply objects got mixed
 * up across requests under the rapid concurrent calls this project's
 * e2e tests make, surfacing as "reply.code is not a function" unhandled
 * rejections that cascaded into unrelated tests. Registering this
 * directly via `app.getHttpAdapter().getInstance().addHook('onRequest', ...)`
 * in main.ts (after `@fastify/cookie` is registered, so `request.cookies`
 * is already populated) avoids the shim entirely.
 *
 * Ensures every client has a CSRF cookie before they ever submit a
 * mutating request (docs/09-security.md §15.7) — by the time a
 * browser's JS submits a POST, the token CsrfGuard checks for is
 * already there to read and echo back as a header. Not HttpOnly:
 * same-origin JS reading this value and putting it in a request header
 * is exactly the mechanism that makes double-submit CSRF protection
 * work — unlike the session cookies, this one is not a secret an
 * attacker gains anything from reading directly.
 */
export function createCsrfCookieHook(
  env: Pick<Env, 'APP_ENV'>,
): (request: FastifyRequest, reply: FastifyReply, done: () => void) => void {
  return (request, reply, done) => {
    if (!request.cookies?.[CSRF_COOKIE]) {
      reply.setCookie(CSRF_COOKIE, generateCsrfToken(), {
        httpOnly: false,
        secure: env.APP_ENV !== 'local',
        sameSite: 'lax',
        path: '/',
      });
    }
    done();
  };
}
