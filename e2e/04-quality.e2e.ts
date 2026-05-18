import { test, expect } from '@playwright/test';

test('quality page renders gates table and recommended commands', async ({ page }) => {
  await page.goto('/#/quality');
  await expect(page.getByRole('heading', { name: 'Quality' })).toBeVisible();
  // Hero metric cards: Score, Verdict, Blockers/warnings.
  await expect(page.getByText('Score', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Verdict', { exact: false }).first()).toBeVisible();
  // Gate table.
  await expect(page.getByRole('heading', { name: 'Gates' })).toBeVisible();
  // Recommended commands section with at least one copyable block.
  await expect(page.getByRole('heading', { name: 'Recommended commands' })).toBeVisible();
  const cmd = page.getByTestId('command-block').filter({ hasText: 'shrk quality --strict' });
  await expect(cmd).toBeVisible();
});
