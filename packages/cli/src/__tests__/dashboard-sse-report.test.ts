import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboardApiServer } from '../dashboard/dashboard-api-server.ts';

function makeSessionProject(): { cwd: string; id: string; sessionDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'shrk-dashboard-sse-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture' }));
  const id = '20260101T000000Z-sse';
  const sessionDir = join(cwd, '.sharkcraft', 'sessions', id);
  mkdirSync(join(sessionDir, 'plans'), { recursive: true });
  mkdirSync(join(sessionDir, 'reports'), { recursive: true });
  writeFileSync(
    join(sessionDir, 'session.json'),
    JSON.stringify({
      schema: 'sharkcraft.dev-session/v1',
      id,
      task: 'sse fixture',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phase: 'started',
      projectRoot: cwd,
      selectedPipeline: null,
      plans: [],
      validations: [],
      reports: [],
      appliedPlans: [],
      nextAction: null,
      warnings: [],
    }),
  );
  writeFileSync(join(sessionDir, 'intent.md'), '# task\n');
  return { cwd, id, sessionDir };
}

describe('dashboard SSE + report', () => {
  test('GET /api/sessions/:id/events opens an event stream with content-type text/event-stream', async () => {
    const { cwd, id } = makeSessionProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const ac = new AbortController();
      const res = await fetch(`${handle.url}/api/sessions/${id}/events`, {
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      expect((res.headers.get('content-type') ?? '').includes('text/event-stream')).toBe(true);
      // Read at least one chunk — should contain the hello event.
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value);
      expect(chunk).toContain('event: hello');
      ac.abort();
      reader.cancel().catch(() => undefined);
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('GET /api/sessions/:id/events returns 404 for an unknown session', async () => {
    const cwd = makeSessionProject().cwd;
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await fetch(`${handle.url}/api/sessions/nope/events`);
      expect(r.status).toBe(404);
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('POST /api/sessions/:id/events returns 405', async () => {
    const { cwd, id } = makeSessionProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await fetch(`${handle.url}/api/sessions/${id}/events`, { method: 'POST' });
      expect(r.status).toBe(405);
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('GET /api/sessions/:id/report.html returns sandboxed HTML', async () => {
    const { cwd, id } = makeSessionProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await fetch(`${handle.url}/api/sessions/${id}/report.html`);
      expect(r.status).toBe(200);
      expect((r.headers.get('content-type') ?? '').startsWith('text/html')).toBe(true);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      const csp = r.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      const html = await r.text();
      expect(html).toContain('sse fixture');
      expect(html.toLowerCase()).not.toContain('<script');
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('GET /api/sessions/:id/report.html returns 404 for unknown session', async () => {
    const cwd = makeSessionProject().cwd;
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await fetch(`${handle.url}/api/sessions/nope/report.html`);
      expect(r.status).toBe(404);
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
