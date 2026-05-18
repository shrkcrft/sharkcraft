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
      for (const path of ['/api/health', '/api/capabilities', '/api/overview', '/api/commands', '/api/schemas', '/api/sessions', '/api/onboarding/adoption', '/api/scaffolds', '/api/stats']) {
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
});
