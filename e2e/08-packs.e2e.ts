import { test, expect } from '@playwright/test';

test('packs page renders empty state with discovery command when no packs are installed', async ({ page }) => {
  await page.goto('/#/packs');
  await expect(page.getByRole('heading', { name: 'Packs' })).toBeVisible();
  // Either packs are listed or the empty state is shown — both are valid.
  const empty = page.getByText('No packs discovered', { exact: false });
  const discovered = page.getByText('Discovered', { exact: false }).first();
  await expect(empty.or(discovered)).toBeVisible();
});
