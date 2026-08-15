// docs/09-security.md §15.7's header set, minus Content-Security-Policy
// — that one moved to `src/middleware.ts` because it needs a fresh
// nonce on every request (Next's own RSC hydration payload is an
// inline `<script>` on every page load; a static per-build CSP can't
// express a per-request nonce). See middleware.ts's doc comment for
// why this was required, not just cleanup.
const cdnOrigin = process.env.CDN_BASE_URL ?? 'http://localhost:9000';

const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(), microphone=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
];

// Phase 19: `next/image`'s remote-domain allowlist, derived from the
// same `cdnOrigin` the CSP's `img-src` already trusts — restaurant
// logos/menu-item photos are the only remote images this app ever
// renders (docs/09-security.md §15.6: object keys are server-generated
// UUIDs, never a client-controlled path).
const cdnUrl = new URL(cdnOrigin);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // apps/web imports workspace packages (@direct-order/contracts,
  // @direct-order/money) directly from their TypeScript source in
  // development; Next needs to know to transpile them rather than
  // treating them as pre-built node_modules.
  transpilePackages: ['@direct-order/contracts', '@direct-order/money'],
  eslint: {
    // Linting is handled by the repo-wide `pnpm lint` (root
    // eslint.config.js, which already includes next/core-web-vitals
    // scoped to this app). Next's own build-time ESLint pass doesn't
    // recognize that custom flat config and would otherwise run a
    // second, less-configured lint pass during `next build`.
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: cdnUrl.protocol.replace(':', ''),
        hostname: cdnUrl.hostname,
        port: cdnUrl.port || undefined,
      },
    ],
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

// Phase 19 "frontend bundle optimisation": `ANALYZE=true pnpm --filter
// @direct-order/web build` emits an interactive bundle-composition
// report — opt-in via env var, never runs in a normal build/CI.
const withBundleAnalyzer = (await import('@next/bundle-analyzer')).default({
  enabled: process.env.ANALYZE === 'true',
});

export default withBundleAnalyzer(nextConfig);
