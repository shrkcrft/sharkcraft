import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboardApiServer } from '../dashboard/dashboard-api-server.ts';

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-dashboard-server-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.1' }));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.ts'), '// noop\n');
  return dir;
}

async function http(method: string, url: string, init?: RequestInit): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(url, { method, ...init });
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

describe('dashboard-api-server', () => {
  test('GET endpoints return JSON envelopes', async () => {
    const cwd = makeProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      for (const path of ['/api/health', '/api/capabilities', '/api/overview', '/api/commands', '/api/schemas', '/api/sessions', '/api/onboarding/adoption', '/api/scaffolds', '/api/stats', '/api/compression']) {
        const r = await http('GET', `${handle.url}${path}`);
        expect(r.status).toBe(200);
        const env = JSON.parse(r.body) as { schema: string; data: unknown; projectRoot: string };
        expect(env.schema).toBe('sharkcraft.dashboard-api/v1');
        expect(env.projectRoot).toBe(cwd);
        expect(env.data).toBeTruthy();
      }
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('compression endpoint reports per-surface token savings', async () => {
    const cwd = makeProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await http('GET', `${handle.url}/api/compression`);
      expect(r.status).toBe(200);
      const env = JSON.parse(r.body) as {
        data: {
          surfaces: { surface: string; strategy: string; before: number; after: number; savedPct: number }[];
          totals: { before: number; after: number; savedPct: number };
          tokensAreEstimated: boolean;
        };
      };
      expect(Array.isArray(env.data.surfaces)).toBe(true);
      expect(typeof env.data.totals.before).toBe('number');
      expect(typeof env.data.totals.after).toBe('number');
      expect(typeof env.data.totals.savedPct).toBe('number');
      // Honesty flag: the panel must declare whether counts are estimated or
      // exact, so the UI never presents an approximation as a precise number.
      expect(typeof env.data.tokensAreEstimated).toBe('boolean');
      for (const s of env.data.surfaces) {
        // The compression layer must never inflate a surface.
        expect(s.after).toBeLessThanOrEqual(s.before);
      }
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('POST/PUT/PATCH/DELETE return 405 with allow header', async () => {
    const cwd = makeProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const r = await http(method, `${handle.url}/api/overview`);
        expect(r.status).toBe(405);
        const allow = r.headers.get('allow') ?? '';
        expect(allow.toUpperCase()).toContain('GET');
        expect(allow.toUpperCase()).toContain('HEAD');
      }
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('health reports readOnly: true', async () => {
    const cwd = makeProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await http('GET', `${handle.url}/api/health`);
      const env = JSON.parse(r.body) as { data: { ok: boolean; readOnly: boolean; apiVersion: string } };
      expect(env.data.ok).toBe(true);
      expect(env.data.readOnly).toBe(true);
      expect(env.data.apiVersion).toBe('1');
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('capabilities lists no write endpoints', async () => {
    const cwd = makeProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await http('GET', `${handle.url}/api/capabilities`);
      const env = JSON.parse(r.body) as { data: { writeEndpoints: unknown[]; dangerousActions: unknown[]; readOnly: boolean } };
      expect(env.data.readOnly).toBe(true);
      expect(env.data.writeEndpoints.length).toBe(0);
      expect(env.data.dangerousActions.length).toBe(0);
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unknown route returns 404 JSON', async () => {
    const cwd = makeProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await http('GET', `${handle.url}/api/no-such-thing`);
      expect(r.status).toBe(404);
      const env = JSON.parse(r.body) as { data: { code: string } };
      expect(env.data.code).toBe('not-found');
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('missing session returns 404', async () => {
    const cwd = makeProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await http('GET', `${handle.url}/api/sessions/nope`);
      expect(r.status).toBe(404);
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('graph why requires from+to', async () => {
    const cwd = makeProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await http('GET', `${handle.url}/api/graph/why`);
      expect(r.status).toBe(400);
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('knowledge routes are read-only and degrade cleanly on an empty workspace', async () => {
    const cwd = makeProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const list = await http('GET', `${handle.url}/api/knowledge`);
      expect(list.status).toBe(200);
      const listEnv = JSON.parse(list.body) as { data: { available: boolean; total: number } };
      expect(listEnv.data.available).toBe(false);
      expect(listEnv.data.total).toBe(0);

      const graph = await http('GET', `${handle.url}/api/knowledge/graph`);
      expect(graph.status).toBe(200);
      expect((JSON.parse(graph.body) as { data: { available: boolean } }).data.available).toBe(false);

      const missing = await http('GET', `${handle.url}/api/knowledge/entry/does-not-exist`);
      expect(missing.status).toBe(200);
      expect((JSON.parse(missing.body) as { data: { found: boolean } }).data.found).toBe(false);

      const similar = await http('GET', `${handle.url}/api/knowledge/similar/does-not-exist`);
      expect(similar.status).toBe(200);
      expect((JSON.parse(similar.body) as { data: { available: boolean } }).data.available).toBe(false);

      // Ask without an LLM (no entries → short-circuits before any model call).
      const ask = await http('GET', `${handle.url}/api/knowledge/ask?q=how%20do%20I%20generate`);
      expect(ask.status).toBe(200);
      const askEnv = JSON.parse(ask.body) as { data: { llmAvailable: boolean; degraded: boolean; answer: string | null } };
      expect(askEnv.data.degraded).toBe(true);
      expect(askEnv.data.answer).toBe(null);

      // Ask requires a question.
      const badAsk = await http('GET', `${handle.url}/api/knowledge/ask`);
      expect(badAsk.status).toBe(400);

      // Write verbs are rejected globally.
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const w = await http(method, `${handle.url}/api/knowledge`);
        expect(w.status).toBe(405);
      }
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('knowledge entry resolves against a real workspace', async () => {
    // Point at the repo itself so the loaders surface real entries + the graph.
    const handle = await startDashboardApiServer({ cwd: process.cwd() });
    try {
      const list = await http('GET', `${handle.url}/api/knowledge`);
      const listEnv = JSON.parse(list.body) as {
        data: { available: boolean; total: number; entries: { id: string }[] };
      };
      expect(listEnv.data.available).toBe(true);
      expect(listEnv.data.total).toBeGreaterThan(0);

      const id = listEnv.data.entries[0]!.id;
      const entry = await http('GET', `${handle.url}/api/knowledge/entry/${encodeURIComponent(id)}`);
      expect(entry.status).toBe(200);
      const entryEnv = JSON.parse(entry.body) as {
        data: { found: boolean; entry?: { id: string; content: string } };
      };
      expect(entryEnv.data.found).toBe(true);
      expect(entryEnv.data.entry?.id).toBe(id);
      expect(typeof entryEnv.data.entry?.content).toBe('string');

      const similar = await http('GET', `${handle.url}/api/knowledge/similar/${encodeURIComponent(id)}`);
      const simEnv = JSON.parse(similar.body) as { data: { id: string; similar: { id: string }[] } };
      expect(simEnv.data.id).toBe(id);
      // The entry must never be similar to itself.
      expect(simEnv.data.similar.some((s) => s.id === id)).toBe(false);
    } finally {
      await handle.close();
    }
  });
});
