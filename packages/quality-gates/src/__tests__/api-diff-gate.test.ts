import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractApiSurface } from '@shrkcrft/api-surface-diff';
import { GraphStore, buildFullIndex } from '@shrkcrft/graph';
import { apiDiffGate } from '../index.ts';

/** A single-package workspace; `index.ts` content is supplied per build. */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-api-diff-gate-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'lib', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'lib', 'package.json'),
    JSON.stringify({ name: '@demo/lib', main: 'src/index.ts' }, null, 2),
  );
  return root;
}

/** (Re)write the package entrypoint and (re)build the on-disk code graph. */
function writeIndex(root: string, src: string): void {
  writeFileSync(join(root, 'packages', 'lib', 'src', 'index.ts'), src);
  buildFullIndex({ projectRoot: root });
}

/**
 * Capture the current graph surface to a baseline JSON file — exactly the
 * AST-only surface the gate re-extracts, so an unchanged tree diffs clean.
 */
function captureBaseline(root: string): string {
  const surface = extractApiSurface(new GraphStore(root).loadSnapshot());
  const p = join(root, 'api-baseline.json');
  writeFileSync(p, JSON.stringify(surface, null, 2));
  return p;
}

const TWO_EXPORTS = 'export function foo() { return 1; }\nexport function bar() { return 2; }';

describe('apiDiffGate', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  test('missing/garbage baseline → skipped + capture hint', () => {
    root = makeRoot();
    writeIndex(root, TWO_EXPORTS);
    const r = apiDiffGate(root, { baselinePath: 'does-not-exist.json' });
    expect(r.status).toBe('skipped');
    expect(r.nextCommands?.some((c) => c.startsWith('shrk api-diff capture'))).toBe(true);
  });

  test('valid baseline but no graph index → skipped + graph-index hint', () => {
    root = makeRoot();
    // Write a syntactically valid baseline WITHOUT building the graph store.
    const baselinePath = join(root, 'api-baseline.json');
    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          schema: 'sharkcraft.api-surface/v1',
          symbols: [],
          countsByPackage: {},
          total: 0,
        },
        null,
        2,
      ),
    );
    const r = apiDiffGate(root, { baselinePath });
    expect(r.status).toBe('skipped');
    expect(r.message).toContain('graph index missing');
    expect(r.nextCommands).toContain('shrk graph index');
  });

  test('removed exported symbol → fail with breaking count (failOnBreaking default)', () => {
    root = makeRoot();
    writeIndex(root, TWO_EXPORTS);
    const baselinePath = captureBaseline(root);
    // Sanity: the baseline must carry real symbols or the diff is meaningless.
    expect(extractApiSurface(new GraphStore(root).loadSnapshot()).total).toBeGreaterThanOrEqual(2);
    // Drop `bar` → a removed public symbol → breaking.
    writeIndex(root, 'export function foo() { return 1; }');
    const r = apiDiffGate(root, { baselinePath });
    expect(r.status).toBe('fail');
    expect((r.details as { breaking?: number } | undefined)?.breaking).toBeGreaterThan(0);
    expect((r.details as { removed?: number } | undefined)?.removed).toBeGreaterThan(0);
  });

  test('failOnBreaking:false downgrades a breaking diff to warn (not fail)', () => {
    root = makeRoot();
    writeIndex(root, TWO_EXPORTS);
    const baselinePath = captureBaseline(root);
    writeIndex(root, 'export function foo() { return 1; }');
    const r = apiDiffGate(root, { baselinePath, failOnBreaking: false });
    expect(r.status).toBe('warn');
    expect((r.details as { breaking?: number } | undefined)?.breaking).toBeGreaterThan(0);
  });

  test('added exported symbol (non-breaking) → pass with counts', () => {
    root = makeRoot();
    writeIndex(root, TWO_EXPORTS);
    const baselinePath = captureBaseline(root);
    // Add `baz` → additive only.
    writeIndex(root, TWO_EXPORTS + '\nexport function baz() { return 3; }');
    const r = apiDiffGate(root, { baselinePath });
    expect(r.status).toBe('pass');
    expect((r.details as { added?: number } | undefined)?.added).toBeGreaterThan(0);
    expect((r.details as { breaking?: number } | undefined)?.breaking).toBe(0);
  });

  test('identical surface → pass with the no-change message', () => {
    root = makeRoot();
    writeIndex(root, TWO_EXPORTS);
    const baselinePath = captureBaseline(root);
    const r = apiDiffGate(root, { baselinePath });
    expect(r.status).toBe('pass');
    expect(r.message).toBe('No API surface changes.');
  });
});
