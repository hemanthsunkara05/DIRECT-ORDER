import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content-Security-Policy, moved here from `next.config.mjs`'s static
 * `headers()` because it needs a fresh nonce on every request — found
 * live (gstack `browse`, real headless Chromium): the App Router
 * streams its own RSC hydration payload via inline
 * `<script>self.__next_f.push(...)</script>` tags on every single page,
 * in dev AND production, and a static `script-src 'self'` with no
 * `'unsafe-inline'`/nonce blocks every one of them outright — the
 * console showed a dozen "Executing inline script violates ... CSP"
 * errors per page load, and React never received its hydration data
 * (the same failure the RSC client reports as "Connection closed").
 *
 * A per-request nonce (not a blanket `'unsafe-inline'`) is the correct
 * fix, not a shortcut: `'unsafe-inline'` on script-src would silence
 * this specific error but reopen the exact XSS-via-injected-<script>
 * hole docs/09-security.md §15.7's CSP exists to close, in production
 * as much as dev. A nonce lets Next's own internal scripts execute
 * while any attacker-injected `<script>` (which can't know the nonce)
 * still gets blocked — see
 * https://nextjs.org/docs/app/guides/content-security-policy, the
 * documented mechanism this follows.
 *
 * `'unsafe-eval'` remains dev-only (Fast Refresh's actual requirement,
 * unrelated to inline scripts — nonces don't cover `eval()` at all).
 *
 * `'strict-dynamic'` matches Next's own documented example verbatim
 * (verified against the live docs, not recalled from memory). With a
 * nonce present, browsers that support strict-dynamic ignore `'self'`
 * for script-src entirely and trust only the nonce plus anything a
 * nonced script itself loads/injects (e.g. webpack's runtime injecting
 * a code-split chunk's <script> tag) — strictly narrower than `'self'`
 * alone, not a relaxation.
 *
 * Nonces only work on dynamically-rendered pages — apps/web/src/app/
 * layout.tsx's `await connection()` opts the whole app into that,
 * required so `next build` doesn't prerender pages (this app had no
 * page reading cookies()/headers(), so nothing forced that already)
 * with no nonce baked in, which would reproduce this exact bug in
 * production despite working in `next dev`.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
  const cdnOrigin = process.env.CDN_BASE_URL ?? 'http://localhost:9000';
  const PAYMENT_PROVIDER_ORIGIN = 'https://checkout.razorpay.com';

  const csp = [
    "default-src 'self'",
    `img-src 'self' data: ${cdnOrigin}`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `frame-src ${PAYMENT_PROVIDER_ORIGIN}`,
    `connect-src 'self' ${apiOrigin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Every request except static assets and image optimization, which
     * don't render HTML/scripts and don't need a nonce.
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
