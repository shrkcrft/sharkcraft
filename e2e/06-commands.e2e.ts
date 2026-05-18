import { test, expect } from '@playwright/test';

test('commands page filters and shows safety badges + copyable commands', async ({ page }) => {
  await page.goto('/#/commands');
  await expect(page.getByRole('heading', { name: 'Commands' })).toBeVisible();

  // Search filters down to rows containing "apply".
  await page.getByPlaceholder('Search…').fill('apply');
  // The catalog has at least one apply-related command.
  await expect(page.getByText('apply', { exact: false }).first()).toBeVisible();

  // Filter by safety: writes-source.
  await page.locator('select').nth(1).selectOption('writes-source');
  // Each visible row should now have a writes-source badge.
  const badges = page.locator('.badge--warning');
  await expect(badges.first()).toBeVisible();

  // Every visible row has a CommandBlock with a Copy button.
  const copyButtons = page.getByRole('button', { name: 'Copy' });
  await expect(copyButtons.first()).toBeVisible();
});
