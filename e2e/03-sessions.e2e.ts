import { test, expect } from '@playwright/test';

test.describe('sessions and session detail', () => {
  test('sessions list shows the fixture session and navigates to its detail', async ({ page }) => {
    await page.goto('/#/sessions');
    await expect(page.getByRole('heading', { name: 'Dev sessions' })).toBeVisible();
    const row = page.getByText('Add a User profile service', { exact: false });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(/#\/sessions\/2026-05-13-fixture-task/);
  });

  test('session detail renders phase, plans, artifacts, and the report iframe toggle', async ({ page }) => {
    await page.goto('/#/sessions/2026-05-13-fixture-task');

    await expect(page.getByRole('heading', { name: 'Add a User profile service' })).toBeVisible();
    await expect(page.getByText('phase:', { exact: false })).toBeVisible();

    // Plans section — one plan row.
    await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
    await expect(page.getByText('user-service', { exact: false }).first()).toBeVisible();

    // Artifacts section.
    await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
    await expect(page.getByText('session-state', { exact: false })).toBeVisible();

    // HTML report iframe toggle.
    await expect(page.getByRole('heading', { name: 'HTML report preview' })).toBeVisible();
    await page.getByRole('button', { name: 'Show inline' }).click();
    const iframe = page.getByTestId('session-report-iframe');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('sandbox', '');
  });
});
