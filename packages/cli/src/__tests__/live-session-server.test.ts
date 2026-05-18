import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDevSession, type IDevSessionLoad } from '@shrkcrft/inspector';
import { startLiveSessionServer } from '../dashboard/live-session-server.ts';

function makeSession(): { cwd: string; load: IDevSessionLoad } {
  const cwd = mkdtempSync(join(tmpdir(), 'shrk-live-session-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture' }));
  const sessionsRoot = join(cwd, '.sharkcraft', 'sessions');
  const id = '20260101T000000Z-test';
  const sessionDir = join(sessionsRoot, id);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(sessionDir, 'plans'), { recursive: true });
  mkdirSync(join(sessionDir, 'reports'), { recursive: true });
  writeFileSync(
    join(sessionDir, 'session.json'),
    JSON.stringify({
      schema: 'sharkcraft.dev-session/v1',
      id,
      task: 'live session test',
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
  const load = scanDevSession(cwd, id);
  if (!load) throw new Error('failed to scan session');
  return { cwd, load };
}

describe('live session server v2', () => {
  test('live HTML contains the SSE script and /events endpoint exists', async () => {
    const { cwd, load } = makeSession();
    const handle = await startLiveSessionServer({ cwd, load, live: true });
    try {
      const html = await fetch(`${handle.url}/`).then((r) => r.text());
      expect(html).toContain('EventSource');
      expect(html).toContain('/events');
      // /events endpoint should respond with SSE content-type. We only assert
      // the headers, then close immediately.
      const ac = new AbortController();
      const evRes = await fetch(`${handle.url}/events`, { signal: ac.signal }).catch(() => null);
      if (evRes) {
        expect(evRes.headers.get('content-type') ?? '').toContain('text/event-stream');
      }
      ac.abort();
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('without --live the HTML has no SSE script', async () => {
    const { cwd, load } = makeSession();
    const handle = await startLiveSessionServer({ cwd, load, live: false });
    try {
      const html = await fetch(`${handle.url}/`).then((r) => r.text());
      expect(html).not.toContain('EventSource');
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('POST/PUT/DELETE return 405', async () => {
    const { cwd, load } = makeSession();
    const handle = await startLiveSessionServer({ cwd, load, live: true });
    try {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = await fetch(`${handle.url}/`, { method });
        expect(r.status).toBe(405);
      }
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
