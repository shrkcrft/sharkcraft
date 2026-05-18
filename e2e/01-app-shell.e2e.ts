import { test, expect } from '@playwright/test';

test.describe('app shell', () => {
  test('loads with sidebar, read-only badge, project root', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('topbar')).toBeVisible();
    await expect(page.getByText('read-only', { exact: false }).first()).toBeVisible();

    // Sidebar nav items render.
    for (const label of [
      'Overview',
      'Dev Sessions',
      'Quality',
      'Safety',
      'Architecture',
      'Knowledge Graph',
      'Packs',
      'Presets & Pipelines',
      'Onboarding',
      'Reports',
      'Review & CI',
      'Commands',
      'MCP',
    ]) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });

  test('document title reflects active page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/SharkCraft\s*[—-]\s*Overview/);
    await page.getByRole('button', { name: 'Quality' }).click();
    await expect(page).toHaveTitle(/SharkCraft\s*[—-]\s*Quality/);
  });
});
