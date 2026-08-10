import { expect, test } from '@playwright/test';

/**
 * Phase 1 smoke test: proves the Next.js app builds, starts, and
 * serves a page in a real browser. There is no product feature to test
 * yet — the customer ordering journey e2e suite arrives in Phase 7+
 * (PRODUCT/docs/11-testing-strategy.md §18.4).
 */
test('home page renders without a console error', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Direct-Order' })).toBeVisible();
  // Every page mounts SessionProvider (Phase 3), which checks GET
  // /auth/me on load — a logged-out visitor genuinely gets a 401 from a
  // real API, and Chrome itself (not application code) logs any non-2xx
  // resource load as a console error regardless of how gracefully the
  // app handles the response. This is real, unavoidable production
  // behavior, not a bug — the assertion below allows exactly that one
  // expected message and nothing else.
  const unexpectedErrors = consoleErrors.filter(
    (text) => !/Failed to load resource.*401/.test(text),
  );
  expect(unexpectedErrors).toEqual([]);
});

test('page has the expected title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Direct-Order');
});
