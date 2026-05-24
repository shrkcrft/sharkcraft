import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function setupFastApiFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-fastapi-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['services/*'] }, null, 2),
  );
  mkdirSync(join(root, 'services', 'api'), { recursive: true });
  writeFileSync(
    join(root, 'services', 'api', 'package.json'),
    JSON.stringify({ name: '@demo/api', main: 'main.py' }, null, 2),
  );
  writeFileSync(
    join(root, 'services', 'api', 'main.py'),
    [
      "from fastapi import FastAPI, APIRouter",
      "",
      "app = FastAPI()",
      "users = APIRouter()",
      "",
      "@app.get('/health')",
      "def health():",
      "    return {'ok': True}",
      "",
      "@app.post('/items')",
      "async def create_item(payload: dict):",
      "    return payload",
      "",
      "@users.get('/users/{user_id}')",
      "def get_user(user_id: str):",
      "    return {'id': user_id}",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'services', 'api', 'helpers.py'),
    "def helper(): return 1",
  );
  return root;
}

describe('fastapi extractor', () => {
  test('detects app, router, and routes (method, path, handler)', () => {
    const root = setupFastApiFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['fastapi'] });
      expect(r.manifest.countsBySubtype['fastapi:app']).toBe(1);
      expect(r.manifest.countsBySubtype['fastapi:router']).toBe(1);
      expect(r.manifest.countsBySubtype['fastapi:route']).toBe(3);
      const api = FrameworkQueryApi.fromStore(root);
      const routes = api.list({ framework: 'fastapi', subtype: 'route' });
      const labels = routes.map((r) => r.label).sort();
      expect(labels).toEqual(['GET /health', 'GET /users/{user_id}', 'POST /items']);
      // Verify handlers are wired.
      const getUser = routes.find((r) => r.label === 'GET /users/{user_id}')!;
      expect(getUser.data?.['handler']).toBe('get_user');
      expect(getUser.data?.['app']).toBe('users');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('handles-route + framework-declares edges land', () => {
    const root = setupFastApiFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['fastapi'] });
      const api = FrameworkQueryApi.fromStore(root);
      const handles = api.edges().filter((e) => e.kind === EdgeKind.HandlesRoute);
      expect(handles.length).toBe(3);
      // 2 apps + 3 routes = 5 framework-declares edges from this file.
      const declares = api
        .edges()
        .filter((e) => e.kind === EdgeKind.FrameworkDeclares && e.from === 'file:services/api/main.py');
      expect(declares.length).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips Python files without FastAPI', () => {
    const root = setupFastApiFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['fastapi'] });
      const api = FrameworkQueryApi.fromStore(root);
      expect(api.forFile('services/api/helpers.py').length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
