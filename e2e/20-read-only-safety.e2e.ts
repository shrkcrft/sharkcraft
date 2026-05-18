/**
 * Safety contract: the dashboard never exposes write paths.
 *
 * If any of these checks fail, treat it as a release blocker — the
 * dashboard's read-only promise has regressed.
 */
import { test, expect } from '@playwright/test';

test('dashboard server rejects every write verb', async ({ request }) => {
  for (const path of ['/api/health', '/api/overview', '/api/sessions']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await request.fetch(path, { method });
      expect(res.status(), `${method} ${path}`).toBe(405);
      expect((res.headers()['allow'] ?? '').toUpperCase()).toContain('GET');
    }
  }
});

test('/api/health reports readOnly: true and the v1 schema id', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { schema: string; data: { readOnly: boolean; ok: boolean } };
  expect(body.schema).toBe('sharkcraft.dashboard-api/v1');
  expect(body.data.readOnly).toBe(true);
  expect(body.data.ok).toBe(true);
});

test('/api/capabilities advertises no write endpoints or dangerous actions', async ({ request }) => {
  const res = await request.get('/api/capabilities');
  const body = (await res.json()) as {
    data: { writeEndpoints: unknown[]; dangerousActions: unknown[]; readOnly: boolean };
  };
  expect(body.data.readOnly).toBe(true);
  expect(body.data.writeEndpoints).toEqual([]);
  expect(body.data.dangerousActions).toEqual([]);
});

test('no apply/run/execute buttons exist anywhere in the UI', async ({ page }) => {
  for (const route of [
    '/#/overview',
    '/#/sessions/2026-05-13-fixture-task',
    '/#/quality',
    '/#/safety',
    '/#/commands',
    '/#/onboarding',
  ]) {
    await page.goto(route);
    // Wait for at least one CommandBlock to appear before scanning for forbidden labels.
    await page.getByTestId('command-block').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
    for (const forbidden of ['Apply now', 'Run command', 'Execute', 'Run plan', 'Apply plan']) {
      expect(
        await page.getByRole('button', { name: forbidden, exact: false }).count(),
        `forbidden button "${forbidden}" on ${route}`,
      ).toBe(0);
    }
  }
});

test('dashboard footer reminds the user it does not write', async ({ page }) => {
  await page.goto('/#/overview');
  await expect(page.getByText('local-first', { exact: false })).toBeVisible();
  await expect(page.getByText('No data leaves your machine', { exact: false })).toBeVisible();
});
