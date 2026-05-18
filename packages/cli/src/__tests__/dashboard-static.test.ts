import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboardApiServer } from '../dashboard/dashboard-api-server.ts';

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-dashboard-static-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }));
  return dir;
}

function makeStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-static-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
  writeFileSync(join(dir, 'assets', 'index-AAA.js'), 'console.log(1);');
  writeFileSync(join(dir, 'assets', 'index-BBB.css'), 'body { color: red; }');
  return dir;
}

describe('dashboard server (static + API)', () => {
  test('GET / returns the dashboard HTML', async () => {
    const cwd = makeProject();
    const staticDir = makeStaticDir();
    const handle = await startDashboardApiServer({ cwd, staticDir });
    try {
      const r = await fetch(`${handle.url}/`);
      expect(r.status).toBe(200);
      expect((r.headers.get('content-type') ?? '').startsWith('text/html')).toBe(true);
      const html = await r.text();
      expect(html).toContain('<div id="root">');
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  test('GET /assets/<file> returns the asset with nosniff', async () => {
    const cwd = makeProject();
    const staticDir = makeStaticDir();
    const handle = await startDashboardApiServer({ cwd, staticDir });
    try {
      const r = await fetch(`${handle.url}/assets/index-AAA.js`);
      expect(r.status).toBe(200);
      expect((r.headers.get('content-type') ?? '').includes('javascript')).toBe(true);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await r.text()).toContain('console.log(1)');
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  test('SPA fallback: unknown path returns index.html', async () => {
    const cwd = makeProject();
    const staticDir = makeStaticDir();
    const handle = await startDashboardApiServer({ cwd, staticDir });
    try {
      const r = await fetch(`${handle.url}/whatever/deep/path`);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('<div id="root">');
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  test('GET /api/health still works alongside static assets and reports readOnly: true', async () => {
    const cwd = makeProject();
    const staticDir = makeStaticDir();
    const handle = await startDashboardApiServer({ cwd, staticDir });
    try {
      const r = await fetch(`${handle.url}/api/health`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { schema: string; data: { readOnly: boolean } };
      expect(body.schema).toBe('sharkcraft.dashboard-api/v1');
      expect(body.data.readOnly).toBe(true);
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  test('POST /api/health returns 405', async () => {
    const cwd = makeProject();
    const handle = await startDashboardApiServer({ cwd });
    try {
      const r = await fetch(`${handle.url}/api/health`, { method: 'POST' });
      expect(r.status).toBe(405);
      expect((r.headers.get('allow') ?? '').toUpperCase()).toContain('GET');
    } finally {
      await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('non-localhost host emits a warning to stderr', async () => {
    const cwd = makeProject();
    const seenWarn: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: typeof process.stderr.write }).write = ((chunk: string) => {
      seenWarn.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let handle;
    try {
      handle = await startDashboardApiServer({ cwd, host: '0.0.0.0', port: 0 });
      expect(seenWarn.join('').includes('beyond localhost')).toBe(true);
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write = origWrite;
      if (handle) await handle.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
