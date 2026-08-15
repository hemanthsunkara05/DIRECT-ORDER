import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * `@fastify/helmet`'s Permissions-Policy support has varied across
 * major versions (dropped, renamed, re-added) in ways `Referrer-Policy`
 * and CSP haven't — set explicitly here, the same "native Fastify hook,
 * not a Nest middleware" convention `createCsrfCookieHook` already
 * established, so this header's exact value (docs/09-security.md
 * §15.7) never depends on a third-party package's current defaults.
 */
export function permissionsPolicyHook(
  _request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  reply.header('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  done();
}
