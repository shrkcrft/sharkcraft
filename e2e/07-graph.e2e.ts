import { test, expect } from '@playwright/test';

test('graph page toggles list/graph views and shows node count', async ({ page }) => {
  await page.goto('/#/graph');
  await expect(page.getByRole('heading', { name: 'Knowledge graph' })).toBeVisible();

  // List view by default — node count chip visible.
  await expect(page.getByText(/\d+ nodes/).first()).toBeVisible();

  // Switch to graph view via the tabs in the page header. Use exact match to
  // avoid colliding with the "Knowledge Graph" sidebar button.
  await page.getByRole('button', { name: 'Graph', exact: true }).click();
  const svg = page.getByTestId('graph-svg');
  const empty = page.getByText('No graph nodes', { exact: false });
  await expect(svg.or(empty).first()).toBeVisible();

  // Graph why form is rendered.
  await expect(page.getByText('Graph "why"')).toBeVisible();
  await expect(page.getByPlaceholder('from id')).toBeVisible();
  await expect(page.getByPlaceholder('to id')).toBeVisible();
});
