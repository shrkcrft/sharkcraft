import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listIndexableFiles, SemanticIndex, type ISemanticIndexEntry } from '@shrkcrft/embeddings';

let tempRepo = '';

beforeEach(() => {
  tempRepo = mkdtempSync(join(tmpdir(), 'shrk-semantic-'));
});

afterEach(() => {
  rmSync(tempRepo, { recursive: true, force: true });
  SemanticIndex._embedderForTests = null;
});

describe('listIndexableFiles', () => {
  test('walks Next.js / single-package roots (src, app, pages) when no monorepo dirs exist', () => {
    mkdirSync(join(tempRepo, 'src'), { recursive: true });
    mkdirSync(join(tempRepo, 'app/dashboard'), { recursive: true });
    writeFileSync(join(tempRepo, 'src/index.ts'), 'export {};\n');
    writeFileSync(join(tempRepo, 'app/dashboard/page.tsx'), 'export default () => null;\n');

    const files = listIndexableFiles(tempRepo);
    expect(files).toContain('src/index.ts');
    expect(files).toContain('app/dashboard/page.tsx');
  });

  test('explicit roots via the `roots` option override defaults', () => {
    mkdirSync(join(tempRepo, 'custom/source'), { recursive: true });
    mkdirSync(join(tempRepo, 'src'), { recursive: true });
    writeFileSync(join(tempRepo, 'custom/source/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(tempRepo, 'src/b.ts'), 'export const b = 2;\n');

    const files = listIndexableFiles(tempRepo, 5000, { roots: ['custom/source'] });
    expect(files).toContain('custom/source/a.ts');
    expect(files).not.toContain('src/b.ts');
  });

  test('falls back to a depth-1 scan of cwd when no conventional root yields files', () => {
    // No `src`, `app`, `packages`, etc. — files live in a quirky layout.
    mkdirSync(join(tempRepo, 'mystuff/code'), { recursive: true });
    writeFileSync(join(tempRepo, 'mystuff/code/x.ts'), 'export const x = 1;\n');
    writeFileSync(join(tempRepo, 'root-level.ts'), 'export const r = 1;\n');

    const files = listIndexableFiles(tempRepo);
    expect(files).toContain('root-level.ts');
    expect(files).toContain('mystuff/code/x.ts');
  });

  test('walks packages/ docs/ examples/ sharkcraft/, skips node_modules, dist, .d.ts', () => {
    mkdirSync(join(tempRepo, 'packages/foo/src'), { recursive: true });
    mkdirSync(join(tempRepo, 'packages/foo/dist'), { recursive: true });
    mkdirSync(join(tempRepo, 'packages/foo/node_modules/sub'), { recursive: true });
    mkdirSync(join(tempRepo, 'docs'), { recursive: true });
    writeFileSync(join(tempRepo, 'packages/foo/src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(tempRepo, 'packages/foo/src/b.tsx'), 'export const B = () => null;\n');
    writeFileSync(join(tempRepo, 'packages/foo/src/c.d.ts'), 'export {};\n');
    writeFileSync(join(tempRepo, 'packages/foo/dist/built.js'), '// nope\n');
    writeFileSync(join(tempRepo, 'packages/foo/node_modules/sub/index.ts'), '// skip\n');
    writeFileSync(join(tempRepo, 'docs/notes.md'), '# notes\n');

    const files = listIndexableFiles(tempRepo);
    expect(files).toContain('packages/foo/src/a.ts');
    expect(files).toContain('packages/foo/src/b.tsx');
    expect(files).toContain('docs/notes.md');
    expect(files).not.toContain('packages/foo/src/c.d.ts');
    expect(files.some((p) => p.includes('node_modules'))).toBe(false);
    expect(files.some((p) => p.includes('/dist/'))).toBe(false);
  });
});

describe('SemanticIndex persistence', () => {
  test('tryLoad() returns null when no index exists yet', async () => {
    const index = await SemanticIndex.tryLoad(tempRepo);
    expect(index).toBeNull();
  });

  test('tryLoad() rejects a mismatched index version', async () => {
    const dir = join(tempRepo, '.sharkcraft/embeddings');
    mkdirSync(dir, { recursive: true });
    const meta = {
      version: 999,
      model: 'test/fake',
      dimensions: 2,
      builtAt: 'now',
      paths: ['a.ts'],
      mtimes: { 'a.ts': 0 },
    };
    writeFileSync(join(dir, 'index-v2.meta.json'), JSON.stringify(meta));
    writeFileSync(join(dir, 'index-v2.vec.bin'), Buffer.from(new Float32Array([1, 0]).buffer));
    const idx = await SemanticIndex.tryLoad(tempRepo);
    expect(idx).toBeNull();
  });

  test('tryLoad() rejects vector file that does not match meta dimensions × file count', async () => {
    const dir = join(tempRepo, '.sharkcraft/embeddings');
    mkdirSync(dir, { recursive: true });
    const meta = {
      version: 2,
      model: 'test/fake',
      dimensions: 4,
      builtAt: 'now',
      paths: ['a.ts', 'b.ts'],
      mtimes: { 'a.ts': 0, 'b.ts': 0 },
    };
    writeFileSync(join(dir, 'index-v2.meta.json'), JSON.stringify(meta));
    writeFileSync(join(dir, 'index-v2.vec.bin'), Buffer.from(new Float32Array([1, 0, 0]).buffer));
    const idx = await SemanticIndex.tryLoad(tempRepo);
    expect(idx).toBeNull();
  });
});

describe('SemanticIndex.freshnessReport', () => {
  test('returns hasIndex=false when no index exists', () => {
    mkdirSync(join(tempRepo, 'packages/foo/src'), { recursive: true });
    writeFileSync(join(tempRepo, 'packages/foo/src/a.ts'), 'export const a = 1;\n');
    const current = ['packages/foo/src/a.ts'];
    const report = SemanticIndex.freshnessReport(tempRepo, current);
    expect(report.hasIndex).toBe(false);
    expect(report.indexed).toBe(0);
    expect(report.untracked).toBe(1);
  });

  test('classifies fresh / stale / missing / untracked against meta.mtimes', async () => {
    writeFileSync(join(tempRepo, 'a.ts'), 'A\n');
    writeFileSync(join(tempRepo, 'b.ts'), 'B\n');
    writeFileSync(join(tempRepo, 'c.ts'), 'C\n');

    SemanticIndex._embedderForTests = async () => new Float32Array([1, 0, 0, 0]);
    try {
      await SemanticIndex.build(
        tempRepo,
        [
          { path: 'a.ts', summary: 'A' },
          { path: 'b.ts', summary: 'B' },
          { path: 'c.ts', summary: 'C' },
        ],
        { model: 'fake/embed' },
      );

      // Simulate the workspace state:
      //   a.ts unchanged → fresh
      //   b.ts touched   → stale
      //   c.ts deleted   → missing
      //   d.ts new       → untracked
      writeFileSync(join(tempRepo, 'd.ts'), 'D\n');
      rmSync(join(tempRepo, 'c.ts'));
      const future = new Date(Date.now() + 60_000);
      utimesSync(join(tempRepo, 'b.ts'), future, future);

      const report = SemanticIndex.freshnessReport(tempRepo, ['a.ts', 'b.ts', 'd.ts']);
      expect(report.hasIndex).toBe(true);
      expect(report.fresh).toBe(1); // a.ts
      expect(report.stale).toBe(1); // b.ts
      expect(report.missing).toBe(1); // c.ts
      expect(report.untracked).toBe(1); // d.ts
      expect(report.stalePaths).toEqual(['b.ts']);
      expect(report.missingPaths).toEqual(['c.ts']);
      expect(report.untrackedPaths).toEqual(['d.ts']);
    } finally {
      SemanticIndex._embedderForTests = null;
    }
  });
});

describe('SemanticIndex build + refresh (fake embedder)', () => {
  function withFakeEmbedder(): { calls: string[] } {
    const calls: string[] = [];
    // Deterministic 4-D fake embedder: each input gets a unit vector
    // derived from its string content. Lets us assert which texts were
    // (re)embedded without depending on a real model.
    SemanticIndex._embedderForTests = async (text: string) => {
      calls.push(text);
      const h = simpleHash(text);
      const v = new Float32Array(4);
      v[0] = Math.sin(h);
      v[1] = Math.cos(h);
      v[2] = Math.sin(h * 1.7);
      v[3] = Math.cos(h * 0.3);
      // Normalize so cosine similarity == dot product.
      let mag = 0;
      for (let i = 0; i < 4; i += 1) mag += v[i]! * v[i]!;
      mag = Math.sqrt(mag);
      for (let i = 0; i < 4; i += 1) v[i] = v[i]! / mag;
      return v;
    };
    return { calls };
  }

  test('build() embeds every entry and persists meta + vectors that load back', async () => {
    writeFileSync(join(tempRepo, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(tempRepo, 'b.ts'), 'export const b = 2;\n');
    const entries: ISemanticIndexEntry[] = [
      { path: 'a.ts', summary: 'A', exports: ['a'] },
      { path: 'b.ts', summary: 'B', exports: ['b'] },
    ];

    const { calls } = withFakeEmbedder();
    const index = await SemanticIndex.build(tempRepo, entries, { model: 'fake/embed' });
    expect(index.fileCount).toBe(2);
    expect(index.modelName).toBe('fake/embed');
    // probe (for dim detection) + 2 file embeddings
    expect(calls.length).toBe(3);

    // Round-trip through persistence
    const reloaded = await SemanticIndex.tryLoad(tempRepo, { model: 'fake/embed' });
    expect(reloaded).not.toBeNull();
    expect(reloaded!.fileCount).toBe(2);
  });

  test('refresh() with no changes does NOT call the embedder', async () => {
    writeFileSync(join(tempRepo, 'a.ts'), 'export const a = 1;\n');
    const entries: ISemanticIndexEntry[] = [{ path: 'a.ts', summary: 'A', exports: ['a'] }];

    withFakeEmbedder();
    await SemanticIndex.build(tempRepo, entries, { model: 'fake/embed' });

    const reloaded = await SemanticIndex.tryLoad(tempRepo, { model: 'fake/embed' });
    expect(reloaded).not.toBeNull();
    const { calls } = withFakeEmbedder();
    const report = await reloaded!.refresh(entries);
    expect(report).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 1,
      totalAfter: 1,
      rebuilt: false,
    });
    expect(calls.length).toBe(0);
  });

  test('refresh() re-embeds only changed file, drops removed, adds new', async () => {
    writeFileSync(join(tempRepo, 'a.ts'), 'old a\n');
    writeFileSync(join(tempRepo, 'b.ts'), 'old b\n');
    writeFileSync(join(tempRepo, 'c.ts'), 'old c\n');

    const initial: ISemanticIndexEntry[] = [
      { path: 'a.ts', summary: 'A', exports: ['a'] },
      { path: 'b.ts', summary: 'B', exports: ['b'] },
      { path: 'c.ts', summary: 'C', exports: ['c'] },
    ];
    withFakeEmbedder();
    await SemanticIndex.build(tempRepo, initial, { model: 'fake/embed' });

    // Mutate b.ts (changed) and bump its mtime forward
    writeFileSync(join(tempRepo, 'b.ts'), 'new b body\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(tempRepo, 'b.ts'), future, future);
    // Delete c.ts, add d.ts
    rmSync(join(tempRepo, 'c.ts'));
    writeFileSync(join(tempRepo, 'd.ts'), 'fresh d\n');

    const reloaded = await SemanticIndex.tryLoad(tempRepo, { model: 'fake/embed' });
    expect(reloaded).not.toBeNull();
    const { calls } = withFakeEmbedder();
    const refreshed: ISemanticIndexEntry[] = [
      { path: 'a.ts', summary: 'A', exports: ['a'] }, // unchanged
      { path: 'b.ts', summary: 'B', exports: ['b'] }, // changed mtime → re-embed
      { path: 'd.ts', summary: 'D', exports: ['d'] }, // new
    ];
    const report = await reloaded!.refresh(refreshed);
    expect(report.added).toBe(1); // d.ts
    expect(report.changed).toBe(1); // b.ts
    expect(report.removed).toBe(1); // c.ts
    expect(report.unchanged).toBe(1); // a.ts
    expect(report.totalAfter).toBe(3);
    // Exactly 2 embedder calls — one for b.ts (changed), one for d.ts (new).
    expect(calls.length).toBe(2);

    // Persisted state reflects the new contents
    const final = await SemanticIndex.tryLoad(tempRepo, { model: 'fake/embed' });
    expect(final!.fileCount).toBe(3);
  });

  test('searchFiles() returns a self-match with score ~1.0 when query == descriptor', async () => {
    writeFileSync(join(tempRepo, 'auth.ts'), 'login flow\n');
    writeFileSync(join(tempRepo, 'render.ts'), 'render frames\n');
    const entries: ISemanticIndexEntry[] = [
      { path: 'auth.ts', summary: 'authentication and login', exports: ['login'] },
      { path: 'render.ts', summary: 'frame rendering', exports: ['render'] },
    ];

    withFakeEmbedder();
    const index = await SemanticIndex.build(tempRepo, entries, { model: 'fake/embed' });

    // The descriptor used at build time is exactly: path\nsummary\nexports: ...
    const authDescriptor = 'auth.ts\nauthentication and login\nexports: login';
    const hits = await index.searchFiles(authDescriptor, 2);
    expect(hits[0]?.path).toBe('auth.ts');
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  test('searchFiles() never returns a path whose file was deleted on disk', async () => {
    writeFileSync(join(tempRepo, 'auth.ts'), 'login flow\n');
    writeFileSync(join(tempRepo, 'render.ts'), 'render frames\n');
    const entries: ISemanticIndexEntry[] = [
      { path: 'auth.ts', summary: 'authentication and login', exports: ['login'] },
      { path: 'render.ts', summary: 'frame rendering', exports: ['render'] },
    ];

    withFakeEmbedder();
    const index = await SemanticIndex.build(tempRepo, entries, { model: 'fake/embed' });

    // Delete auth.ts on disk WITHOUT reindexing — the index still holds its
    // vector (a stale index), so an unguarded scan would rank it #1 for its
    // own descriptor and feed a dead path into the smart-context seed.
    rmSync(join(tempRepo, 'auth.ts'));

    const authDescriptor = 'auth.ts\nauthentication and login\nexports: login';
    const hits = await index.searchFiles(authDescriptor, 2);
    // The query-time prune drops the deleted path entirely; only the
    // still-present file survives.
    expect(hits.map((h) => h.path)).not.toContain('auth.ts');
    expect(hits.map((h) => h.path)).toContain('render.ts');
  });
});

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
