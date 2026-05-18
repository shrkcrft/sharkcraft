import { test, expect } from '@playwright/test';

test.describe('overview page', () => {
  test('shows the hero metrics, recommended commands, and recent sessions', async ({ page }) => {
    await page.goto('/#/overview');

    // Wait for the page to leave the loading state.
    await expect(page.getByText('Loading overview', { exact: false })).toHaveCount(0, { timeout: 10_000 });

    // The 4 hero metric cards.
    await expect(page.getByText('AI Readiness', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Quality', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Safety', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Sessions', { exact: false }).first()).toBeVisible();

    // Section: next recommended commands. Show at least one copyable command block.
    const cmdBlocks = page.getByTestId('command-block');
    await expect(cmdBlocks.first()).toBeVisible();
    await expect(cmdBlocks.first()).toContainText('shrk');

    // Recent sessions table renders the fixture session.
    await expect(page.getByText('Recent sessions', { exact: false })).toBeVisible();
    await expect(page.getByText('Add a User profile service', { exact: false })).toBeVisible();
  });
});
