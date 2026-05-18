import { test, expect } from '@playwright/test';

test('MCP page surfaces the read-only banner and setup commands', async ({ page }) => {
  await page.goto('/#/mcp');
  await expect(page.getByRole('heading', { name: 'MCP' })).toBeVisible();

  // read-only badge in the summary card.
  await expect(page.getByText('read-only', { exact: false }).first()).toBeVisible();

  // Setup commands. Multiple blocks match "shrk mcp serve" (stdio + http variant).
  await expect(page.getByTestId('command-block').filter({ hasText: 'shrk mcp serve' }).first()).toBeVisible();
});
