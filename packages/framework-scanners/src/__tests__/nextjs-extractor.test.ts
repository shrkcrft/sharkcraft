import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function setupNextFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-fw-next-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'web', 'app', 'users', '[id]'), { recursive: true });
  mkdirSync(join(root, 'packages', 'web', 'app', '(marketing)', 'about'), { recursive: true });
  mkdirSync(join(root, 'packages', 'web', 'app', 'api', 'users'), { recursive: true });
  mkdirSync(join(root, 'packages', 'web', 'pages', '[slug]'), { recursive: true });
  mkdirSync(join(root, 'packages', 'web', 'pages', 'api'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'web', 'package.json'),
    JSON.stringify({ name: '@demo/web', main: 'app/page.tsx' }, null, 2),
  );

  // App router: page, layout, dynamic page, route group, route.ts with methods.
  writeFileSync(
    join(root, 'packages', 'web', 'app', 'page.tsx'),
    "export default function Page() { return <div>home</div>; }",
  );
  writeFileSync(
    join(root, 'packages', 'web', 'app', 'layout.tsx'),
    "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }",
  );
  writeFileSync(
    join(root, 'packages', 'web', 'app', 'users', '[id]', 'page.tsx'),
    "export default function UserPage() { return <div>user</div>; }",
  );
  writeFileSync(
    join(root, 'packages', 'web', 'app', '(marketing)', 'about', 'page.tsx'),
    "export default function About() { return <div>about</div>; }",
  );
  writeFileSync(
    join(root, 'packages', 'web', 'app', 'api', 'users', 'route.ts'),
    [
      "export async function GET() { return new Response('users'); }",
      "export async function POST(req: Request) { return new Response('created'); }",
    ].join('\n'),
  );
  // Pages router: pages/foo.tsx, pages/[slug]/index.tsx, pages/api/health.ts.
  writeFileSync(
    join(root, 'packages', 'web', 'pages', 'foo.tsx'),
    "export default function Foo() { return <div>foo</div>; }",
  );
  writeFileSync(
    join(root, 'packages', 'web', 'pages', '[slug]', 'index.tsx'),
    "export default function Slug() { return <div>slug</div>; }",
  );
  writeFileSync(
    join(root, 'packages', 'web', 'pages', 'api', 'health.ts'),
    "export default function handler() { return { ok: true }; }",
  );
  return root;
}

describe('nextjs extractor', () => {
  test('detects app-router pages, layouts, and routes (with methods)', () => {
    const root = setupNextFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['nextjs'] });
      // 3 app-router pages (/, /users/:id, /about) + 2 pages-router (/foo, /:slug).
      expect(r.manifest.countsBySubtype['nextjs:page']).toBe(5);
      expect(r.manifest.countsBySubtype['nextjs:layout']).toBe(1);
      // route.ts has GET + POST → 2 route entities.
      expect(r.manifest.countsBySubtype['nextjs:route']).toBe(2);
      const api = FrameworkQueryApi.fromStore(root);
      const pages = api.list({ framework: 'nextjs', subtype: 'page' });
      const appPaths = pages
        .filter((p) => (p.data?.['kind'] as string) !== 'pages-route')
        .map((p) => p.data?.['routePath'] as string)
        .sort();
      expect(appPaths).toEqual(['/', '/about', '/users/:id']);
      const routes = api.list({ framework: 'nextjs', subtype: 'route' });
      const routeMethods = routes.map((r) => `${r.data?.['method']} ${r.data?.['routePath']}`).sort();
      expect(routeMethods).toEqual(['GET /api/users', 'POST /api/users']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects pages-router pages and api routes', () => {
    const root = setupNextFixture();
    try {
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['nextjs'] });
      const api = FrameworkQueryApi.fromStore(root);
      const pages = api.list({ framework: 'nextjs', subtype: 'page' });
      const fooPage = pages.find((p) => p.data?.['routePath'] === '/foo');
      expect(fooPage).toBeDefined();
      const slugPage = pages.find((p) => p.data?.['routePath'] === '/:slug');
      expect(slugPage).toBeDefined();
      const apiRoutes = api.list({ framework: 'nextjs', subtype: 'api-route' });
      expect(apiRoutes.length).toBe(1);
      expect(apiRoutes[0]!.data?.['routePath']).toBe('/api/health');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('skips files that are neither app/* nor pages/*', () => {
    const root = setupNextFixture();
    try {
      writeFileSync(
        join(root, 'packages', 'web', 'random.ts'),
        "export const x = 1;",
      );
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['nextjs'] });
      const api = FrameworkQueryApi.fromStore(root);
      expect(api.forFile('packages/web/random.ts').length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
