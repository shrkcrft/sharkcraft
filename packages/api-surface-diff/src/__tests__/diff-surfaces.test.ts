import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, GraphStore } from '@shrkcrft/graph';
import { diffApiSurfaces, extractApiSurface } from '../index.ts';

function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-api-diff-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'beta', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'package.json'),
    JSON.stringify({ name: '@demo/beta', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    [
      "export function alpha() { return 1; }",
      "export const ALPHA_TAG = 'a';",
      "export interface IConfig { name: string; }",
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'src', 'index.ts'),
    "export const beta = 1;",
  );
  return root;
}

function captureSurface(root: string) {
  buildFullIndex({ projectRoot: root });
  const snap = new GraphStore(root).loadSnapshot();
  return extractApiSurface(snap);
}

describe('extractApiSurface', () => {
  test('emits one entry per exported symbol with package + kind', () => {
    const root = setupFixture();
    try {
      const surface = captureSurface(root);
      const names = surface.symbols.map((s) => s.name).sort();
      expect(names).toContain('alpha');
      expect(names).toContain('ALPHA_TAG');
      expect(names).toContain('IConfig');
      expect(names).toContain('beta');
      const alphaSym = surface.symbols.find((s) => s.name === 'alpha')!;
      expect(alphaSym.package).toBe('@demo/alpha');
      expect(alphaSym.kind).toBe('function');
      const iface = surface.symbols.find((s) => s.name === 'IConfig')!;
      expect(iface.kind).toBe('interface');
      // The constant variable counts as 'const'.
      const tagSym = surface.symbols.find((s) => s.name === 'ALPHA_TAG')!;
      expect(tagSym.kind).toBe('const');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('filters by package', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const snap = new GraphStore(root).loadSnapshot();
      const surface = extractApiSurface(snap, { packageFilter: ['@demo/alpha'] });
      const pkgs = new Set(surface.symbols.map((s) => s.package));
      expect(pkgs.has('@demo/alpha')).toBe(true);
      expect(pkgs.has('@demo/beta')).toBe(false);
      // A filter that matched a real package leaves unmatchedFilters absent.
      expect(surface.unmatchedFilters).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports unmatchedFilters when a --packages value matches no known package', () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const snap = new GraphStore(root).loadSnapshot();
      // `@demo/ghost` is not a workspace package — must NOT silently return 0
      // symbols with no signal.
      const surface = extractApiSurface(snap, { packageFilter: ['@demo/ghost'] });
      expect(surface.total).toBe(0);
      expect(surface.unmatchedFilters).toEqual(['@demo/ghost']);
      // Partial: one real, one bogus — only the bogus one is reported.
      const partial = extractApiSurface(snap, {
        packageFilter: ['@demo/alpha', '@demo/ghost'],
      });
      expect(partial.symbols.length).toBeGreaterThan(0);
      expect(partial.unmatchedFilters).toEqual(['@demo/ghost']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('diffApiSurfaces', () => {
  test('reports added symbols as additive', () => {
    const root = setupFixture();
    try {
      const baseline = captureSurface(root);
      // Add a new export to alpha.
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        [
          "export function alpha() { return 1; }",
          "export const ALPHA_TAG = 'a';",
          "export interface IConfig { name: string; }",
          "export function newThing() { return 42; }",
        ].join('\n'),
      );
      const current = captureSurface(root);
      const diff = diffApiSurfaces(baseline, current);
      expect(diff.added).toBe(1);
      expect(diff.removed).toBe(0);
      expect(diff.breakingCount).toBe(0);
      expect(diff.entries.some((e) => e.kind === 'added' && e.symbol.name === 'newThing')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports removed symbols as breaking', () => {
    const root = setupFixture();
    try {
      const baseline = captureSurface(root);
      // Remove ALPHA_TAG.
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        [
          "export function alpha() { return 1; }",
          "export interface IConfig { name: string; }",
        ].join('\n'),
      );
      const current = captureSurface(root);
      const diff = diffApiSurfaces(baseline, current);
      expect(diff.removed).toBe(1);
      expect(diff.breakingCount).toBeGreaterThanOrEqual(1);
      const entry = diff.entries.find((e) => e.kind === 'removed')!;
      expect(entry.symbol.name).toBe('ALPHA_TAG');
      expect(entry.severity).toBe('breaking');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports kind change (function → const) as breaking', () => {
    const root = setupFixture();
    try {
      const baseline = captureSurface(root);
      // Rewrite alpha from function to const.
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        [
          "export const alpha = () => 1;",
          "export const ALPHA_TAG = 'a';",
          "export interface IConfig { name: string; }",
        ].join('\n'),
      );
      const current = captureSurface(root);
      const diff = diffApiSurfaces(baseline, current);
      const changed = diff.entries.find((e) => e.kind === 'kind-changed' && e.symbol.name === 'alpha');
      expect(changed).toBeDefined();
      expect(changed!.severity).toBe('breaking');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cross-package move is reported as breaking moved-package', () => {
    const root = setupFixture();
    try {
      const baseline = captureSurface(root);
      // Move 'beta' from @demo/beta into @demo/alpha. (Remove from beta, add to alpha.)
      writeFileSync(
        join(root, 'packages', 'beta', 'src', 'index.ts'),
        "export const placeholder = 1;",
      );
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        [
          "export function alpha() { return 1; }",
          "export const ALPHA_TAG = 'a';",
          "export interface IConfig { name: string; }",
          "export const beta = 1;",
        ].join('\n'),
      );
      const current = captureSurface(root);
      const diff = diffApiSurfaces(baseline, current);
      const moved = diff.entries.find((e) => e.kind === 'moved-package' && e.symbol.name === 'beta');
      expect(moved).toBeDefined();
      expect(moved!.severity).toBe('breaking');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
