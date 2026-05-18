import { test, expect } from '@playwright/test';

test('safety page proves the MCP read-only invariant', async ({ page }) => {
  await page.goto('/#/safety');
  await expect(page.getByRole('heading', { name: 'Safety', exact: true })).toBeVisible();

  // MCP write invariant: big PASS badge + descriptive text.
  await expect(page.getByText('MCP write invariant', { exact: false })).toBeVisible();
  await expect(page.getByText('PASS', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('MCP is read-only', { exact: false })).toBeVisible();

  // CLI safety-level counts: 4 metric cards including read-only and writes-source.
  await expect(page.getByText('CLI safety levels', { exact: false })).toBeVisible();
  await expect(page.getByText('read-only', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('writes-source', { exact: false }).first()).toBeVisible();

  // Write-capable and shell-running sections render (chips or "None.").
  await expect(page.getByRole('heading', { name: 'Write-capable commands' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Shell-running commands' })).toBeVisible();

  // Pack & plan signing.
  await expect(page.getByRole('heading', { name: 'Pack & plan signing' })).toBeVisible();

  // Audit command block is copyable.
  await expect(
    page.getByTestId('command-block').filter({ hasText: 'shrk safety audit --json' }),
  ).toBeVisible();
});
