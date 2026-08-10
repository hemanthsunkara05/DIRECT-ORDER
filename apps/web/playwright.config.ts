import { defineConfig, devices } from '@playwright/test';

// This sandbox has no Docker / live Postgres, so there is no real API +
// seeded restaurant to browser-test the Phase 7 public ordering page
// against. The mock server (e2e/support/mock-public-api-server.mjs)
// stands in for it — a second webServer entry, started alongside the
// real Next.js app, with NEXT_PUBLIC_API_BASE_URL pointed at it so the
// app's actual SSR data-fetching code runs unmodified.
const MOCK_API_URL = 'http://localhost:4310';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.WEB_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/support/mock-public-api-server.mjs',
      url: `${MOCK_API_URL}/api/v1/public/restaurants/spice-route`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: 'pnpm build && pnpm start',
      url: process.env.WEB_BASE_URL ?? 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NEXT_PUBLIC_API_BASE_URL: MOCK_API_URL },
    },
  ],
});
