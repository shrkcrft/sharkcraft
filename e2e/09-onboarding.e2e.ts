import { test, expect } from '@playwright/test';

test('onboarding page shows adoption state and copyable commands', async ({ page }) => {
  await page.goto('/#/onboarding');
  await expect(page.getByRole('heading', { name: 'Onboarding & adoption' })).toBeVisible();
  // 4 metric cards.
  await expect(page.getByText('Inferred rules', { exact: false })).toBeVisible();
  await expect(page.getByText('Inferred paths', { exact: false })).toBeVisible();
  await expect(page.getByText('Inferred templates', { exact: false })).toBeVisible();
  await expect(page.getByText('Imported agents', { exact: false })).toBeVisible();

  // Either there's no adoption state (empty state) or the state is shown.
  const emptyState = page.getByText('No adoption state yet', { exact: false });
  const presentState = page.getByText('format:', { exact: false }).first();
  await expect(emptyState.or(presentState)).toBeVisible();

  // Next-commands section: at least one CommandBlock with shrk onboard.
  await expect(
    page.getByTestId('command-block').filter({ hasText: 'shrk onboard' }).first(),
  ).toBeVisible();
});
