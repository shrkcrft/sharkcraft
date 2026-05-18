/**
 * SSE smoke. We avoid mutating the committed fixture — instead we verify the
 * stream opens and emits the `hello` event. UI-level live refresh is covered
 * by the dashboard's own polling fallback (session detail re-fetches when
 * `useSessionEvents.version` increments, and that is exercised by the
 * 03-sessions spec).
 */
import { test, expect } from '@playwright/test';

test('GET /api/sessions/:id/events streams the hello event', async ({ request, baseURL }) => {
  expect(baseURL).toBeTruthy();
  const res = await fetch(`${baseURL}/api/sessions/2026-05-13-fixture-task/events`);
  expect(res.status).toBe(200);
  expect((res.headers.get('content-type') ?? '').includes('text/event-stream')).toBe(true);
  const reader = res.body!.getReader();
  try {
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain('event: hello');
    expect(chunk).toContain('data: 2026-05-13-fixture-task');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
});

test('the session detail page shows a "live" or "polling" indicator', async ({ page }) => {
  await page.goto('/#/sessions/2026-05-13-fixture-task');
  const live = page.getByText('live', { exact: true });
  const polling = page.getByText('polling', { exact: true });
  await expect(live.or(polling)).toBeVisible();
});
