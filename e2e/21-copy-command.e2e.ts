import { test, expect } from '@playwright/test';

// Pre-grant clipboard permission for the entire file so navigator.clipboard
// works in Chromium headless. Browsers that don't honor the grant fall back
// to the textarea+execCommand path inside the CommandBlock component.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('CommandBlock copy flips to a "Copied" state without executing', async ({ page }) => {
  await page.goto('/#/quality');

  // Pick the well-known recommended command.
  const block = page.getByTestId('command-block').filter({ hasText: 'shrk quality --strict' }).first();
  await expect(block).toBeVisible();
  const copyBtn = block.getByRole('button', { name: 'Copy' });
  await copyBtn.click();

  // The button text flips to "Copied" briefly.
  await expect(block.getByRole('button', { name: 'Copied' })).toBeVisible({ timeout: 2000 });

  // Best-effort clipboard read.
  const clipboard = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  });
  if (clipboard !== null) {
    expect(clipboard).toBe('shrk quality --strict');
  }
});
