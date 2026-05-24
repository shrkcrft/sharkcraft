import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, EdgeKind } from '@shrkcrft/graph';
import { runExtractors, FrameworkQueryApi } from '../index.ts';

function setupBase(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-vsf-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  return root;
}

describe('vue extractor', () => {
  test('detects .vue SFC + hook usage', () => {
    const root = setupBase();
    try {
      mkdirSync(join(root, 'packages', 'web', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'web', 'package.json'),
        JSON.stringify({ name: '@demo/web', main: 'src/index.ts' }, null, 2),
      );
      writeFileSync(
        join(root, 'packages', 'web', 'src', 'Counter.vue'),
        [
          '<template><div>{{ count }}</div></template>',
          '<script setup lang="ts">',
          "import { ref, onMounted } from 'vue';",
          'const count = ref(0);',
          'onMounted(() => console.log("mounted"));',
          '</script>',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['vue'] });
      expect(r.manifest.countsBySubtype['vue:component']).toBe(1);
      expect((r.manifest.countsBySubtype['vue:hook-usage'] ?? 0)).toBeGreaterThanOrEqual(2);
      const api = FrameworkQueryApi.fromStore(root);
      const c = api.list({ framework: 'vue', subtype: 'component' })[0]!;
      expect(c.label).toBe('Counter');
      expect(c.data?.['setup']).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects defineComponent() in .ts files', () => {
    const root = setupBase();
    try {
      mkdirSync(join(root, 'packages', 'web', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'web', 'package.json'),
        JSON.stringify({ name: '@demo/web', main: 'src/index.ts' }, null, 2),
      );
      writeFileSync(
        join(root, 'packages', 'web', 'src', 'index.ts'),
        [
          "import { defineComponent } from 'vue';",
          "export default defineComponent({ name: 'MyComp' });",
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['vue'] });
      expect(r.manifest.countsBySubtype['vue:component']).toBe(1);
      const api = FrameworkQueryApi.fromStore(root);
      expect(api.list({ framework: 'vue', subtype: 'component' })[0]!.label).toBe('MyComp');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('svelte extractor', () => {
  test('detects .svelte components + runes + stores', () => {
    const root = setupBase();
    try {
      mkdirSync(join(root, 'packages', 'web', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'web', 'package.json'),
        JSON.stringify({ name: '@demo/web', main: 'src/index.ts' }, null, 2),
      );
      writeFileSync(
        join(root, 'packages', 'web', 'src', 'Counter.svelte'),
        [
          '<script>',
          "import { count } from './store';",
          'let n = $state(0);',
          'let doubled = $derived(n * 2);',
          'function inc() { n += 1; $count = $count + 1; }',
          '</script>',
          '<button on:click={inc}>{n} ({doubled})</button>',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['svelte'] });
      const api = FrameworkQueryApi.fromStore(root);
      const c = api.list({ framework: 'svelte', subtype: 'component' })[0]!;
      expect(c.label).toBe('Counter');
      expect((c.data?.['runes'] as string[])).toContain('$state');
      expect((c.data?.['runes'] as string[])).toContain('$derived');
      expect((c.data?.['stores'] as string[])).toContain('$count');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detects .svelte.ts module files', () => {
    const root = setupBase();
    try {
      mkdirSync(join(root, 'packages', 'web', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'web', 'package.json'),
        JSON.stringify({ name: '@demo/web', main: 'src/index.ts' }, null, 2),
      );
      writeFileSync(
        join(root, 'packages', 'web', 'src', 'shared.svelte.ts'),
        [
          'export const count = $state(0);',
          'export const doubled = $derived(count * 2);',
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      runExtractors({ projectRoot: root, only: ['svelte'] });
      const api = FrameworkQueryApi.fromStore(root);
      const m = api.list({ framework: 'svelte', subtype: 'module' })[0]!;
      expect(m.label).toBe('shared');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('fastify extractor', () => {
  test('detects fastify() server + routes', () => {
    const root = setupBase();
    try {
      mkdirSync(join(root, 'packages', 'api', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'api', 'package.json'),
        JSON.stringify({ name: '@demo/api', main: 'src/server.ts' }, null, 2),
      );
      writeFileSync(
        join(root, 'packages', 'api', 'src', 'server.ts'),
        [
          "import fastify from 'fastify';",
          "const app = fastify({ logger: true });",
          "app.get('/health', async () => ({ ok: true }));",
          "app.post('/echo', async (req) => req.body);",
          "app.route({ method: 'PUT', url: '/items/:id', handler: async () => ({}) });",
        ].join('\n'),
      );
      buildFullIndex({ projectRoot: root });
      const r = runExtractors({ projectRoot: root, only: ['fastify'] });
      expect(r.manifest.countsBySubtype['fastify:server']).toBe(1);
      expect(r.manifest.countsBySubtype['fastify:route']).toBe(3);
      const api = FrameworkQueryApi.fromStore(root);
      const routes = api.list({ framework: 'fastify', subtype: 'route' });
      const labels = routes.map((r) => r.label).sort();
      expect(labels).toEqual(['GET /health', 'POST /echo', 'PUT /items/:id']);
      const handlesEdges = api.edges().filter((e) => e.kind === EdgeKind.HandlesRoute);
      expect(handlesEdges.length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
