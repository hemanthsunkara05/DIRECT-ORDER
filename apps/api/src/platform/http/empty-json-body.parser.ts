import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Fastify's default `application/json` parser (`getDefaultJsonParser`
 * in fastify's own `contentTypeParser.js`) rejects an empty body with
 * `FST_ERR_CTP_EMPTY_JSON_BODY` ("Body cannot be empty when
 * content-type is set to 'application/json'") unconditionally — found
 * live: the frontend sends `Content-Type: application/json` with a
 * genuinely empty body on every no-payload action (`POST
 * /restaurant/orders/:id/accept`, `/reject`, etc. — none of these
 * handlers even declare a `@Body()` parameter), so the request never
 * reached the handler at all, failing at Fastify's own parsing layer
 * before Nest's routing had any say. Confirmed the exact trigger by
 * reading fastify 4.28.1's own source: it checks the fully-read Buffer
 * directly (`body.length === 0`), not any header — a `Content-Length:
 * 0` check would have been unreliable anyway, since neither curl nor
 * (apparently) the app's own `fetch()` calls send that header for a
 * bodyless request.
 *
 * `@nestjs/platform-fastify`'s `rawBody: true` (main.ts, needed for
 * the webhook's HMAC signature verification) works by registering its
 * OWN `application/json` content-type parser that captures
 * `request.rawBody` before delegating to Fastify's real default
 * parser (`FastifyAdapter.useBodyParser`/`registerJsonContentParser`
 * in `@nestjs/platform-fastify`'s source). This function REMOVES that
 * registration and replaces it with one that replicates the exact
 * same `rawBody` capture and proto/constructor-poisoning protection,
 * inserting only the empty-body check — real payloads (including
 * every real webhook body, which is never empty) go through
 * byte-for-byte identical handling to before.
 */
export function registerEmptyJsonBodyParser(instance: FastifyInstance): void {
  const contentType = 'application/json';
  const { bodyLimit, onProtoPoisoning, onConstructorPoisoning } = instance.initialConfig;
  // `getDefaultJsonParser`'s type signature says `FastifyBodyParser<string>`,
  // but its actual implementation (fastify 4.28.1's contentTypeParser.js)
  // checks `Buffer.isBuffer(body)` as well as `body === ''` — a real
  // Buffer works at runtime even though the .d.ts only names `string`;
  // `@nestjs/platform-fastify` itself calls this the same way, with a
  // Buffer, in `registerJsonContentParser`. Verified against fastify's
  // own source, not assumed.
  const defaultJsonParser = instance.getDefaultJsonParser(
    onProtoPoisoning ?? 'error',
    onConstructorPoisoning ?? 'error',
  ) as unknown as (request: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => void;

  instance.removeContentTypeParser(contentType);
  instance.addContentTypeParser(
    contentType,
    { parseAs: 'buffer', bodyLimit },
    (request: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
      (request as unknown as { rawBody?: Buffer }).rawBody = body;
      if (body.length === 0) {
        done(null, {});
        return;
      }
      defaultJsonParser(request, body, done);
    },
  );
}
