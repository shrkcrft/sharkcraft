import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractApiSurfaceWithProgram, loadSignatureCache } from '../index.ts';

function setup(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-sigcache-'));
  mkdirSync(join(root, 'packages', 'lib', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['packages/*/src/**/*.ts'],
    }),
  );
  writeFileSync(
    join(root, 'packages', 'lib', 'package.json'),
    JSON.stringify({ name: '@demo/lib', main: 'src/index.ts' }),
  );
  writeFileSync(join(root, 'packages', 'lib', 'src', 'index.ts'), body);
  return root;
}

describe('extractApiSurfaceWithProgram — signature cache', () => {
  test('second run on unchanged source returns 100% cache hits', () => {
    const root = setup('export function id<T>(x: T): T { return x; }\nexport interface IBox<T> { value: T; }');
    try {
      const first = extractApiSurfaceWithProgram({ projectRoot: root });
      expect(first.cacheStats.enabled).toBe(true);
      expect(first.cacheStats.hits).toBe(0);
      expect(first.cacheStats.misses).toBeGreaterThan(0);
      // Cache file written.
      expect(existsSync(join(root, '.sharkcraft', 'api-surface', 'signatures.json'))).toBe(true);

      const second = extractApiSurfaceWithProgram({ projectRoot: root });
      expect(second.cacheStats.hits).toBe(first.cacheStats.misses);
      expect(second.cacheStats.misses).toBe(0);
      expect(second.cacheStats.filesReused).toBeGreaterThanOrEqual(1);
      // Signatures must still be present (sourced from cache).
      const id = second.surface.symbols.find((s) => s.name === 'id')!;
      expect(id.signature).toBeDefined();
      expect(id.signature).not.toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('changed file invalidates only that file (other files still hit cache)', () => {
    const root = setup('export const A = 1;');
    try {
      // Add a second file.
      writeFileSync(join(root, 'packages', 'lib', 'src', 'b.ts'), 'export const B = 2;');
      // Wire b.ts into a single tsconfig include.
      const first = extractApiSurfaceWithProgram({ projectRoot: root });
      expect(first.cacheStats.misses).toBeGreaterThanOrEqual(2);

      // Modify b.ts only.
      writeFileSync(join(root, 'packages', 'lib', 'src', 'b.ts'), 'export const B = 3;\nexport const C = 4;');
      const second = extractApiSurfaceWithProgram({ projectRoot: root });
      // A is unchanged → hit. B / C are new → miss.
      expect(second.cacheStats.hits).toBeGreaterThanOrEqual(1);
      expect(second.cacheStats.misses).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('useCache: false forces a full rebuild', () => {
    const root = setup('export const X = 1;');
    try {
      extractApiSurfaceWithProgram({ projectRoot: root });
      const r = extractApiSurfaceWithProgram({ projectRoot: root, useCache: false });
      expect(r.cacheStats.enabled).toBe(false);
      expect(r.cacheStats.hits).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('corrupted cache file is treated as cold start', () => {
    const root = setup('export const X = 1;');
    try {
      mkdirSync(join(root, '.sharkcraft', 'api-surface'), { recursive: true });
      writeFileSync(join(root, '.sharkcraft', 'api-surface', 'signatures.json'), 'not json {');
      const r = extractApiSurfaceWithProgram({ projectRoot: root });
      expect(r.cacheStats.misses).toBeGreaterThan(0);
      // And subsequent runs work.
      const second = extractApiSurfaceWithProgram({ projectRoot: root });
      expect(second.cacheStats.hits).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cache file roundtrips through loadSignatureCache', () => {
    const root = setup('export const X = 1;');
    try {
      extractApiSurfaceWithProgram({ projectRoot: root });
      const cache = loadSignatureCache(root);
      expect(cache.schema).toBe('sharkcraft.api-surface-cache/v1');
      const files = Object.keys(cache.files);
      expect(files.length).toBeGreaterThan(0);
      const first = cache.files[files[0]!]!;
      expect(first.sha1).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Silence unused-import warning when adjusting tests.
void readFileSync;
