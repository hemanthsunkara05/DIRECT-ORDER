// docs/09-security.md §15.7's exact header set. `next.config.mjs` runs
// server-side (build/request time), so it can read the real deploy-time
// env vars directly — CDN_BASE_URL/NEXT_PUBLIC_API_BASE_URL aren't
// secrets (they're public origins the browser already loads
// images/makes API calls from), just not otherwise wired into this
// app's own env loading; the localhost fallbacks below only ever
// matter in local dev, where CSP is far lower-stakes than production.
const apiOrigin = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
const cdnOrigin = process.env.CDN_BASE_URL ?? 'http://localhost:9000';
// Real Razorpay checkout is unverified end-to-end in this environment
// (RAZORPAY_KEY_ID/etc. — see PHASE_REPORTS.md's Phase 9 entry); this
// is the actual origin their hosted checkout iframe loads from, wired
// ahead of when real credentials exist, matching how PAYMENT_PROVIDER
// itself was scaffolded ahead of Phase 9's real adapter.
const PAYMENT_PROVIDER_ORIGIN = 'https://checkout.razorpay.com';

// `next dev`'s Fast Refresh runtime evaluates hot-reloaded module code
// via `eval()` — with a strict `script-src 'self'` this throws
// `EvalError: ... violates ... 'unsafe-eval' is not an allowed source`
// on every page, the React tree never finishes hydrating, and no
// onClick/onSubmit handler ever attaches (found live: every login
// button silently did nothing). `next build`/`next start` never call
// eval() for this, so `NODE_ENV` — set automatically by the Next.js
// CLI itself, never by this app's own config — is the correct, always-
// accurate gate: production keeps the strict docs/09 §15.7 policy
// unchanged, only local `next dev` gets the relaxation Fast Refresh
// actually needs.
const isDev = process.env.NODE_ENV === 'development';

const CSP = [
  "default-src 'self'",
  `img-src 'self' data: ${cdnOrigin}`,
  `script-src 'self'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  `frame-src ${PAYMENT_PROVIDER_ORIGIN}`,
  `connect-src 'self' ${apiOrigin}`,
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
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
