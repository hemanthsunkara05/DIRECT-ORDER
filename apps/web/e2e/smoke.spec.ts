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
  expect(consoleErrors).toEqual([]);
});

test('page has the expected title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Direct-Order');
});
