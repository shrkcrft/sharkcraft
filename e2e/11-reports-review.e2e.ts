import { test, expect } from '@playwright/test';

test('reports page renders the report catalogue', async ({ page }) => {
  await page.goto('/#/reports');
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  // Five reports.
  for (const title of [
    'Quality report',
    'Safety audit',
    'Adoption report',
    'Review packet renderer',
    'Dev session report',
  ]) {
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  }
});

test('review & CI page shows the empty state when no packet is supplied', async ({ page }) => {
  await page.goto('/#/review-ci');
  await expect(page.getByRole('heading', { name: 'Review & CI' })).toBeVisible();
  await expect(page.getByText('No review packet provided', { exact: false })).toBeVisible();
});
