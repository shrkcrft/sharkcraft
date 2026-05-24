import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function setupExpressFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-fw-express-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'api', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'api', 'package.json'),
    JSON.stringify({ name: '@demo/api', main: 'src/server.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'api', 'src', 'server.ts'),
    [
      "import express, { Router } from 'express';",
      "const app = express();",
      "const userRouter = Router();",
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      "app.post('/echo', (req, res) => res.json(req.body));",
      "userRouter.get('/:id', (req, res) => res.json({ id: req.params.id }));",
      "app.use('/users', userRouter);",
    ].join('\n'),
  );
  // A non-express file the extractor should skip.
  writeFileSync(
    join(root, 'packages', 'api', 'src', 'noop.ts'),
    "export const helper = () => 1;",
  );
  return root;
}

describe('express extractor', () => {
  test('detects routers + routes (method, path)', () => {
    const root = setupExpressFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['express'] });
      expect(r.manifest.countsBySubtype['express:router']).toBe(2); // app + userRouter
      expect(r.manifest.countsBySubtype['express:route']).toBe(3);  // GET /health, POST /echo, GET /:id
      const api = FrameworkQueryApi.fromStore(root);
      const routes = api.list({ framework: 'express', subtype: 'route' });
      const labels = routes.map((r) => r.label).sort();
      expect(labels).toEqual(['GET /:id', 'GET /health', 'POST /echo']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('handles-route + framework-declares edges land', () => {
    const root = setupExpressFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['express'] });
      const api = FrameworkQueryApi.fromStore(root);
      const handlesEdges = api.edges().filter((e) => e.kind === EdgeKind.HandlesRoute);
      expect(handlesEdges.length).toBe(3);
      const declaresEdges = api.edges().filter((e) => e.kind === EdgeKind.FrameworkDeclares);
      // 2 routers + 3 routes = 5 declares edges from the file.
      expect(declaresEdges.length).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips files with no express signal', () => {
    const root = setupExpressFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['express'] });
      const api = FrameworkQueryApi.fromStore(root);
      expect(api.forFile('packages/api/src/noop.ts').length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
