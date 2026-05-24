import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function base(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-solid-astro-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  return root;
}

describe('solid extractor', () => {
  test('detects function components + createSignal/createEffect primitives', () => {
    const root = base();
    try {
      mkdirSync(join(root, 'packages', 'ui', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'ui', 'package.json'),
        JSON.stringify({ name: '@demo/ui', main: 'src/index.tsx' }, null, 2),
      );
      writeFileSync(
        join(root, 'packages', 'ui', 'src', 'Counter.tsx'),
        [
          "import { createSignal, createEffect } from 'solid-js';",
          "export function Counter() {",
          "  const [count, setCount] = createSignal(0);",
          "  createEffect(() => console.log(count()));",
          "  return <button onClick={() => setCount(count() + 1)}>{count()}</button>;",
          "}",
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['solid'] });
      expect(r.manifest.countsBySubtype['solid:component']).toBe(1);
      expect(r.manifest.countsBySubtype['solid:primitive-usage']).toBeGreaterThanOrEqual(2);
      const api = FrameworkQueryApi.fromStore(root);
      const comps = api.list({ framework: 'solid', subtype: 'component' });
      expect(comps[0]!.label).toBe('Counter');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('astro extractor', () => {
  test('detects pages, components, and api routes', () => {
    const root = base();
    try {
      mkdirSync(join(root, 'packages', 'web', 'src', 'pages', 'blog', '[slug]'), { recursive: true });
      mkdirSync(join(root, 'packages', 'web', 'src', 'pages', 'api'), { recursive: true });
      mkdirSync(join(root, 'packages', 'web', 'src', 'components'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'web', 'package.json'),
        JSON.stringify({ name: '@demo/web' }, null, 2),
      );
      writeFileSync(join(root, 'packages', 'web', 'src', 'pages', 'index.astro'), '<h1>home</h1>');
      writeFileSync(
        join(root, 'packages', 'web', 'src', 'pages', 'blog', '[slug]', 'index.astro'),
        '<h1>{slug}</h1>',
      );
      writeFileSync(
        join(root, 'packages', 'web', 'src', 'pages', 'api', 'health.ts'),
        'export const GET = () => new Response("ok");',
      );
      writeFileSync(
        join(root, 'packages', 'web', 'src', 'components', 'Card.astro'),
        '<div><slot /></div>',
      );

      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['astro'] });
      expect(r.manifest.countsBySubtype['astro:page']).toBe(2);
      expect(r.manifest.countsBySubtype['astro:component']).toBe(1);
      expect(r.manifest.countsBySubtype['astro:api-route']).toBe(1);
      const api = FrameworkQueryApi.fromStore(root);
      const pages = api.list({ framework: 'astro', subtype: 'page' });
      const routes = pages.map((p) => p.data?.['routePath'] as string).sort();
      expect(routes).toEqual(['/', '/blog/:slug']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
