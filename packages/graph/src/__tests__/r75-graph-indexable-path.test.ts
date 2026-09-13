/**
 * Round 11 (post-review) — "would the code-graph index know this file?" has
 * ONE answer: `isGraphIndexablePath` (an indexed extension AND no path segment
 * the walk skips, from the shared `GRAPH_SKIP_DIRS`).
 *
 * Before it, the orphan check answered by extension alone while the index
 * builder ALSO skipped dist/, build/, out/, … — two code paths answering one
 * question. A deleted tracked `dist/x.js` therefore read as a deleted source
 * file the index "should" know, a permanent NOT VERIFIED that re-indexing
 * could never clear. The freshness walk carried a third private copy of the
 * skip list.
 *
 * Property (list ≡ resolve): the file set a REAL full build indexes equals the
 * tree filtered by the predicate; the freshness walk and the incremental
 * updater agree with it. Real builder, real store — no hand-built snapshot.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { buildFullIndex } from '../indexer/index-builder.ts';
import { detectGraphFreshness, updateChanged } from '../indexer/incremental-updater.ts';
import {
  GRAPH_SKIP_DIRS,
  isGraphIndexablePath,
  isGraphSourcePath,
  isGraphWalkSkipped,
} from '../indexer/graph-source-path.ts';
import { GraphStore } from '../store/graph-store.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const TREE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
  'src/a.ts': 'export const A = 1;\n',
  'src/b.js': 'export const B = 1;\n',
  // A segment that merely CONTAINS a skipped name is still indexed.
  'src/dist-utils/c.ts': 'export const C = 1;\n',
  // A dot-file is skipped by the walk's per-entry rule.
  'src/.eslintrc.js': 'module.exports = {};\n',
  // A skipped directory nested below an indexed one.
  'src/gen/out/z.ts': 'export const Z = 1;\n',
  'dist/d.js': 'export const D = 1;\n',
  'build/x.ts': 'export const X = 1;\n',
  'node_modules/pkg/index.js': 'module.exports = 1;\n',
  'out/o.ts': 'export const O = 1;\n',
  'target/t.rs': 'fn main() {}\n',
  'coverage/cv.ts': 'export const Cv = 1;\n',
  '.hidden/h.ts': 'export const H = 1;\n',
  'pkg/dist/p.ts': 'export const P = 1;\n',
  'pkg/src/p.ts': 'export const P2 = 1;\n',
  'README.md': '# hi\n',
};

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-indexable-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(TREE)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** Every file under `root`, as project-relative POSIX paths (no filtering at all). */
function allFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function indexedFiles(root: string): string[] {
  return [...new GraphStore(root).loadSnapshot().files.keys()].sort();
}

describe('isGraphIndexablePath — the one answer to "would the index know this file?"', () => {
  test('the file set a real full build indexes ≡ the tree filtered by the predicate', () => {
    const root = fixture();
    buildFullIndex({ projectRoot: root });
    const expected = allFiles(root).filter((p) => isGraphIndexablePath(p));
    expect(indexedFiles(root)).toEqual(expected);
    // And the predicate is not vacuous: exactly the source outside skipped dirs.
    expect(expected).toEqual(['pkg/src/p.ts', 'src/a.ts', 'src/b.js', 'src/dist-utils/c.ts']);
  });

  test('the freshness walk reports only indexable files as added', () => {
    const root = fixture();
    buildFullIndex({ projectRoot: root });
    for (const rel of ['dist/new.js', 'out/new.ts', 'src/new.ts', 'src/.new.ts', 'build/new.ts']) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), 'export const N = 1;\n');
    }
    const fresh = detectGraphFreshness(root);
    expect(fresh.added).toEqual(['src/new.ts']);
    expect(fresh.modified).toEqual([]);
    expect(fresh.deleted).toEqual([]);
  });

  test('the incremental updater never indexes a file the full build would skip', () => {
    const root = fixture();
    buildFullIndex({ projectRoot: root });
    writeFileSync(join(root, 'dist', 'new.js'), 'export const N = 1;\n');
    writeFileSync(join(root, 'src', 'new.ts'), 'export const N2 = 1;\n');
    const r = updateChanged({ projectRoot: root, changedFiles: ['dist/new.js', 'src/new.ts'] });
    expect([...r.updated]).toEqual(['src/new.ts']);
    expect(indexedFiles(root)).not.toContain('dist/new.js');
    // The incremental index equals what a fresh full build would hold.
    const incremental = indexedFiles(root);
    buildFullIndex({ projectRoot: root });
    expect(incremental).toEqual(indexedFiles(root));
  });

  test('segments, dot-names, extra ignores and paths outside the root', () => {
    expect(isGraphIndexablePath('src/a.ts')).toBe(true);
    expect(isGraphIndexablePath('./src/a.ts')).toBe(true);
    expect(isGraphIndexablePath('src\\win\\a.ts')).toBe(true);
    expect(isGraphIndexablePath('dist/d.js')).toBe(false);
    expect(isGraphIndexablePath('pkg/node_modules/x/index.ts')).toBe(false);
    expect(isGraphIndexablePath('src/.eslintrc.js')).toBe(false);
    expect(isGraphIndexablePath('../outside/a.ts')).toBe(false);
    expect(isGraphIndexablePath('README.md')).toBe(false);
    expect(isGraphIndexablePath('')).toBe(false);
    expect(isGraphIndexablePath('vendor/a.ts')).toBe(true);
    expect(isGraphIndexablePath('vendor/a.ts', ['vendor'])).toBe(false);
    // The extension half alone still answers by extension only.
    expect(isGraphSourcePath('dist/d.js')).toBe(true);
    // Every skipped name is skipped by the per-entry rule the walks apply.
    for (const name of GRAPH_SKIP_DIRS) expect(isGraphWalkSkipped(name)).toBe(true);
    expect(isGraphWalkSkipped('src')).toBe(false);
    expect(isGraphWalkSkipped('vendor', new Set(['vendor']))).toBe(true);
  });
});
