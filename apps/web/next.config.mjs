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
};

export default nextConfig;
