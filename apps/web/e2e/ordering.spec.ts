import { expect, test } from '@playwright/test';

/**
 * Customer browse journey (docs/11-testing-strategy.md §18.4 #1, the
 * portion buildable before checkout/payment exist — see the mock API
 * server's doc comment for why this runs against fixed JSON rather
 * than a live database). Covers the acceptance criteria explicitly
 * named in docs/13-implementation-phases.md, Phase 7: valid slug
 * renders, invalid slug 404s, unavailable items cannot be added, cart
 * persists across refresh, cart rejects cross-restaurant items, and
 * keyboard navigation completes the browse flow.
 */

test('a valid slug renders the restaurant name, categories, and items', async ({ page }) => {
  await page.goto('/r/spice-route');
  await expect(page.getByRole('heading', { name: 'Spice Route' })).toBeVisible();
  await expect(page.getByText('Accepting orders now')).toBeVisible();
  await expect(page.getByText('Idli Sambar')).toBeVisible();
  await expect(page.getByText('Masala Dosa')).toBeVisible();
});

test('an invalid slug 404s', async ({ page }) => {
  const response = await page.goto('/r/does-not-exist');
  expect(response?.status()).toBe(404);
});

test('an unavailable item is shown but cannot be added to cart', async ({ page }) => {
  await page.goto('/r/spice-route');
  const soldOutRow = page.getByRole('listitem').filter({ hasText: 'Medu Vada' });
  await expect(soldOutRow.getByText('Sold out')).toBeVisible();
  await expect(soldOutRow.getByRole('button', { name: 'Add' })).toBeDisabled();
});

test('adding an item shows the cart summary, and it survives a refresh', async ({ page }) => {
  await page.goto('/r/spice-route');

  const dosaRow = page.getByRole('listitem').filter({ hasText: 'Masala Dosa' });
  await dosaRow.getByRole('button', { name: 'Add' }).click();

  await expect(page.getByText('1 item ·')).toBeVisible();

  await page.reload();
  await expect(page.getByText('1 item ·')).toBeVisible();
});

test('opening the cart shows a server-computed price breakdown (Phase 8: server-side cart validation)', async ({
  page,
}) => {
  await page.goto('/r/spice-route');

  const dosaRow = page.getByRole('listitem').filter({ hasText: 'Masala Dosa' });
  await dosaRow.getByRole('button', { name: 'Add' }).click();
  await page.getByRole('button', { name: /View cart/ }).click();

  // The breakdown comes from POST /public/checkout/quote (the mock
  // server's handleQuote), not a client-side estimate — proves the
  // real request/response round-trip renders correctly, not just that
  // local cart math works. ₹120.00 also legitimately appears in the
  // item card, the cart line item, and the collapsed summary bar all
  // at once, so the assertion walks from the unique "Subtotal" label
  // to its adjacent value span (the Row component's exact DOM shape)
  // rather than searching the whole page for the amount.
  const subtotalLabel = page.getByText('Subtotal', { exact: true });
  await expect(subtotalLabel).toBeVisible();
  const subtotalValue = subtotalLabel.locator('xpath=following-sibling::span[1]');
  await expect(subtotalValue).toHaveText('₹120.00'); // Masala Dosa is 12000 paise
  await expect(page.getByRole('button', { name: 'Proceed to checkout' })).toBeEnabled();
});

test('the cart is isolated per restaurant — switching restaurants never mixes items', async ({
  page,
}) => {
  await page.goto('/r/spice-route');
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Masala Dosa' })
    .getByRole('button', { name: 'Add' })
    .click();
  await expect(page.getByText('1 item ·')).toBeVisible();

  await page.goto('/r/copper-kettle');
  await expect(page.getByRole('heading', { name: 'Copper Kettle' })).toBeVisible();
  // No cart summary bar at all — copper-kettle's cart is empty, not carrying spice-route's item.
  await expect(page.getByText(/item ·/)).toHaveCount(0);

  await page.goto('/r/spice-route');
  await expect(page.getByText('1 item ·')).toBeVisible();
});

test('search filters the menu to matching items only', async ({ page }) => {
  await page.goto('/r/spice-route');
  await page.getByPlaceholder('Search the menu…').fill('dosa');

  await expect(page.getByText('Masala Dosa')).toBeVisible();
  await expect(page.getByText('Idli Sambar')).toHaveCount(0);
});

test('keyboard-only navigation reaches category links and an add-to-cart button', async ({
  page,
}) => {
  await page.goto('/r/spice-route');

  const mainsLink = page.getByRole('link', { name: 'Mains' });
  await mainsLink.focus();
  await expect(mainsLink).toBeFocused();
  await page.keyboard.press('Enter');

  const dosaAddButton = page
    .getByRole('listitem')
    .filter({ hasText: 'Masala Dosa' })
    .getByRole('button', { name: 'Add' });
  await dosaAddButton.focus();
  await expect(dosaAddButton).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page.getByText('1 item ·')).toBeVisible();
});
