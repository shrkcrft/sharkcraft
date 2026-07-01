import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGraphCallers,
  runGraphContext,
  runGraphCycles,
  runGraphDeps,
  runGraphHubs,
  runGraphImpact,
  runGraphIndex,
  runGraphPath,
  runGraphSearch,
  runGraphStatus,
  runGraphUnresolved,
} from '../commands/graph-code-subverbs.ts';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-graph-cli-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'p', 'package.json'),
    JSON.stringify({ name: '@demo/p', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'p', 'src', 'index.ts'),
    "export function hello() { return 'world'; }",
  );
  return root;
}

function symbolFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-graph-cli-symbol-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
  );
  mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'p', 'package.json'),
    JSON.stringify({ name: '@demo/p', main: 'src/index.ts' }, null, 2),
  );
  writeFileSync(
    join(root, 'packages', 'p', 'src', 'index.ts'),
    "export function hello() { return 'world'; }\n",
  );
  writeFileSync(
    join(root, 'packages', 'p', 'src', 'consumer.ts'),
    "import { hello } from './index';\nexport const value = hello();\n",
  );
  return root;
}

function makeArgs(positional: string[]): {
  positional: string[];
  flags: Map<string, string | boolean>;
  multiFlags: Map<string, string[]>;
} {
  const flags = new Map<string, string | boolean>();
  flags.set('json', true);
  return {
    positional,
    flags,
    multiFlags: new Map<string, string[]>(),
  };
}

function capture(): { restore: () => string } {
  const orig = process.stdout.write.bind(process.stdout);
  let body = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  return {
    restore() {
      process.stdout.write = orig;
      return body;
    },
  };
}

function captureStderr(): { restore: () => string } {
  const orig = process.stderr.write.bind(process.stderr);
  let body = '';
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return {
    restore() {
      process.stderr.write = orig;
      return body;
    },
  };
}

describe('graph code-intelligence CLI subverbs', () => {
  test('runGraphIndex builds the on-disk store and emits JSON when --json', async () => {
    const root = fixture();
    try {
      const args = withCwd(makeArgs(['index']), root);
      const cap = capture();
      const code = await runGraphIndex(args);
      const out = cap.restore();
      expect(code).toBe(0);
      expect(existsSync(join(root, '.sharkcraft', 'graph', 'meta.json'))).toBe(true);
      const json = JSON.parse(out);
      expect(json.ok).toBe(true);
      expect(json.manifest.schema).toBe('sharkcraft.graph/v1');
      expect(json.manifest.filesIndexed).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphStatus reports missing before index, fresh after', async () => {
    const root = fixture();
    try {
      // Before index.
      const beforeArgs = withCwd(makeArgs(['status']), root);
      const cap1 = capture();
      const code1 = await runGraphStatus(beforeArgs);
      const out1 = cap1.restore();
      expect(code1).toBe(1);
      const json1 = JSON.parse(out1);
      expect(json1.ok).toBe(false);
      expect(json1.nextCommand).toBe('shrk graph index');

      // Index.
      const idxArgs = withCwd(makeArgs(['index']), root);
      capture().restore(); // discard
      await runGraphIndex(idxArgs);

      // After index.
      const afterArgs = withCwd(makeArgs(['status']), root);
      const cap2 = capture();
      const code2 = await runGraphStatus(afterArgs);
      const out2 = cap2.restore();
      expect(code2).toBe(0);
      const json2 = JSON.parse(out2);
      expect(json2.state).toBe('fresh');
      expect(json2.schema).toBe('sharkcraft.graph/v1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphSearch returns symbol matches by name', async () => {
    const root = fixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphSearch(withCwd(makeArgs(['search', 'hello']), root));
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(json.total).toBeGreaterThanOrEqual(1);
      expect(json.matches.some((m: { label: string }) => m.label === 'hello')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('read verbs auto-refresh a stale index by default; --no-refresh opts out', async () => {
    const root = fixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));

      // Add a NEW source file after indexing — the index is now stale.
      writeFileSync(
        join(root, 'packages', 'p', 'src', 'extra.ts'),
        'export function freshlyAdded() { return 1; }\n',
      );

      // Default: auto-refresh picks up the new file and prints a stderr notice.
      const errCap = captureStderr();
      const cap = capture();
      const code = await runGraphSearch(withCwd(makeArgs(['search', 'freshlyAdded']), root));
      const out = cap.restore();
      const err = errCap.restore();
      expect(code).toBe(0);
      expect(JSON.parse(out).total).toBeGreaterThanOrEqual(1);
      expect(err).toContain('(refreshed,');

      // Opt out: --no-refresh leaves the index stale, so a newly-added symbol
      // is not seen.
      writeFileSync(
        join(root, 'packages', 'p', 'src', 'extra2.ts'),
        'export function freshlyAdded2() { return 2; }\n',
      );
      const noRefreshArgs = withCwd(makeArgs(['search', 'freshlyAdded2']), root);
      noRefreshArgs.flags.set('no-refresh', true);
      const cap2 = capture();
      const code2 = await runGraphSearch(noRefreshArgs);
      const out2 = cap2.restore();
      expect(code2).toBe(0);
      expect(JSON.parse(out2).total).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphContext returns symbols for a file path target', async () => {
    const root = fixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphContext(
        withCwd(makeArgs(['context', 'packages/p/src/index.ts']), root),
      );
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(json.anchor.path).toBe('packages/p/src/index.ts');
      expect(json.symbols.some((s: { label: string }) => s.label === 'hello')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphContext enriches symbol targets with declaring file and references', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphContext(withCwd(makeArgs(['context', 'hello']), root));
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(json.anchor.kind).toBe('symbol');
      expect(json.declaredIn.path).toBe('packages/p/src/index.ts');
      expect(json.referencedBy.some((r: { path?: string }) => r.path === 'packages/p/src/consumer.ts')).toBe(true);
      expect(json.calledBy.some((r: { path?: string }) => r.path === 'packages/p/src/consumer.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphImpact returns dependents (zero on a leaf file)', async () => {
    const root = fixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphImpact(
        withCwd(makeArgs(['impact', 'packages/p/src/index.ts']), root),
      );
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(json.schema).toBe('sharkcraft.graph-impact/v1');
      expect(json.directDependents).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphImpact returns dependents for a referenced symbol', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphImpact(withCwd(makeArgs(['impact', 'hello']), root));
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(json.schema).toBe('sharkcraft.graph-impact/v1');
      expect(json.directDependents.some((d: { path?: string }) => d.path === 'packages/p/src/consumer.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphImpact discloses truncation when the blast radius exceeds --limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-cli-impact-cap-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
      );
      mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'p', 'package.json'),
        JSON.stringify({ name: '@demo/p', main: 'src/core.ts' }, null, 2),
      );
      writeFileSync(join(root, 'packages', 'p', 'src', 'core.ts'), 'export const core = 1;');
      for (const u of ['u1', 'u2', 'u3']) {
        writeFileSync(
          join(root, 'packages', 'p', 'src', `${u}.ts`),
          `import { core } from './core.ts';\nexport const ${u} = core;`,
        );
      }
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      // Non-JSON: the truncation note must be emitted.
      const args = withCwd(makeArgs(['impact', 'packages/p/src/core.ts']), root);
      args.flags.delete('json');
      args.flags.set('limit', '1');
      const cap = capture();
      const code = await runGraphImpact(args);
      const out = cap.restore();
      expect(code).toBe(0);
      expect(out).toContain('Showing');
      expect(out).toContain('--limit 1');
      // JSON still carries the honest truncated flag.
      const jsonArgs = withCwd(makeArgs(['impact', 'packages/p/src/core.ts']), root);
      jsonArgs.flags.set('limit', '1');
      const cap2 = capture();
      await runGraphImpact(jsonArgs);
      const json = JSON.parse(cap2.restore());
      expect(json.truncated).toBe(true);
      expect(json.limit).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphCycles reports missing before index', async () => {
    const root = fixture();
    try {
      const cap = capture();
      const code = await runGraphCycles(withCwd(makeArgs(['cycles']), root));
      const out = cap.restore();
      expect(code).toBe(1);
      const json = JSON.parse(out);
      expect(json.ok).toBe(false);
      expect(json.nextCommand).toBe('shrk graph index');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphCycles reports zero cycles on a leaf-only fixture', async () => {
    const root = fixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphCycles(withCwd(makeArgs(['cycles']), root));
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(json.ok).toBe(true);
      expect(json.total).toBe(0);
      expect(json.cycles).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphUnresolved reports zero on a fixture with no broken imports', async () => {
    const root = fixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphUnresolved(withCwd(makeArgs(['unresolved']), root));
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(json.ok).toBe(true);
      expect(json.totalEdges).toBe(0);
      expect(json.files).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphUnresolved enumerates broken imports grouped by file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-cli-unresolved-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
      );
      mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'p', 'package.json'),
        JSON.stringify({ name: '@demo/p', main: 'src/a.ts' }, null, 2),
      );
      writeFileSync(
        join(root, 'packages', 'p', 'src', 'a.ts'),
        "import './missing'; import './also-missing'; export const a = 1;",
      );
      writeFileSync(
        join(root, 'packages', 'p', 'src', 'b.ts'),
        "import './ghost'; export const b = 1;",
      );
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphUnresolved(withCwd(makeArgs(['unresolved']), root));
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(json.totalEdges).toBe(3);
      expect(json.totalFiles).toBe(2);
      const aFile = json.files.find((f: { path: string }) => f.path.endsWith('a.ts'));
      expect(aFile?.unresolved.sort()).toEqual(['./also-missing', './missing']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphDeps lists inbound + outbound package dependencies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-cli-deps-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
      );
      for (const name of ['alpha', 'beta', 'gamma']) {
        mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
        writeFileSync(
          join(root, 'packages', name, 'package.json'),
          JSON.stringify({ name: `@demo/${name}`, main: 'src/index.ts' }, null, 2),
        );
      }
      writeFileSync(
        join(root, 'packages', 'alpha', 'src', 'index.ts'),
        "export const ALPHA = 1;",
      );
      writeFileSync(
        join(root, 'packages', 'beta', 'src', 'index.ts'),
        "import { ALPHA } from '@demo/alpha'; export const BETA = ALPHA;",
      );
      writeFileSync(
        join(root, 'packages', 'gamma', 'src', 'index.ts'),
        "import { BETA } from '@demo/beta'; export const GAMMA = BETA;",
      );
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      // The dispatcher slices off the 'deps' subverb before handing off,
      // so the unit test passes only the package positional.
      const code = await runGraphDeps(withCwd(makeArgs(['@demo/beta']), root));
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(json.ok).toBe(true);
      expect(json.package).toBe('@demo/beta');
      expect(json.dependsOn).toContain('@demo/alpha');
      expect(json.dependedOnBy).toContain('@demo/gamma');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphDeps reports missing index before build', async () => {
    const root = fixture();
    try {
      const cap = capture();
      const code = await runGraphDeps(withCwd(makeArgs(['@demo/p']), root));
      const out = cap.restore();
      expect(code).toBe(1);
      const json = JSON.parse(out);
      expect(json.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphDeps reports not-found for an unknown package (was silently empty)', async () => {
    const root = fixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphDeps(withCwd(makeArgs(['@demo/does-not-exist']), root));
      const out = cap.restore();
      // Mirrors the MCP `not-found` guard: an unknown package is an error, not a
      // confidently-empty `dependsOn: []` that reads as "has no dependencies".
      expect(code).toBe(1);
      const json = JSON.parse(out);
      expect(json.ok).toBe(false);
      expect(json.error).toBe('not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphCallers discloses ambiguity when several symbols share a name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-cli-dup-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
      );
      for (const name of ['alpha', 'beta']) {
        mkdirSync(join(root, 'packages', name, 'src'), { recursive: true });
        writeFileSync(
          join(root, 'packages', name, 'package.json'),
          JSON.stringify({ name: `@demo/${name}`, main: 'src/index.ts' }, null, 2),
        );
        // Both packages export a function named `dup` — an ambiguous name.
        writeFileSync(
          join(root, 'packages', name, 'src', 'index.ts'),
          'export function dup() { return 1; }\n',
        );
      }
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphCallers(withCwd(makeArgs(['callers', 'dup']), root));
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      // Callers are reported for ONE chosen `dup`; the note must say there are
      // others, otherwise the agent reads a partial answer as the whole picture.
      expect(json.note).toContain('2 symbols named "dup"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphCallers ignores a non-numeric --limit instead of zeroing the result', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const args = withCwd(makeArgs(['callers', 'hello']), root);
      // Malformed --limit must not collapse the callers list: `Number('foo')`
      // is NaN, and a NaN slice bound would silently zero out callers while
      // `total` still reported the real count.
      args.flags.set('limit', 'foo');
      const cap = capture();
      const code = await runGraphCallers(args);
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.total).toBeGreaterThanOrEqual(1);
      expect(json.callers.length).toBe(json.total);
      expect(
        json.callers.some((c: { path?: string }) => c.path === 'packages/p/src/consumer.ts'),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphCycles enumerates a manufactured 3-file cycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-cli-cycles-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
      );
      mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'p', 'package.json'),
        JSON.stringify({ name: '@demo/p', main: 'src/a.ts' }, null, 2),
      );
      writeFileSync(join(root, 'packages', 'p', 'src', 'a.ts'), "import './b.ts'; export const a = 1;");
      writeFileSync(join(root, 'packages', 'p', 'src', 'b.ts'), "import './c.ts'; export const b = 1;");
      writeFileSync(join(root, 'packages', 'p', 'src', 'c.ts'), "import './a.ts'; export const c = 1;");
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphCycles(withCwd(makeArgs(['cycles']), root));
      const out = cap.restore();
      expect(code).toBe(0);
      const json = JSON.parse(out);
      expect(json.total).toBe(1);
      expect(json.cycles[0].size).toBe(3);
      expect(json.cycles[0].paths).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphHubs ranks the most-depended-on symbols + files', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphHubs(withCwd(makeArgs(['hubs']), root));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      // `hello` is referenced by consumer.ts (1 distinct dependent file).
      const hello = json.symbols.find((s: { label: string }) => s.label === 'hello');
      expect(hello?.inDegree).toBe(1);
      // index.ts is imported by consumer.ts.
      const idx = json.files.find((f: { path?: string }) => f.path?.endsWith('index.ts'));
      expect(idx?.inDegree).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphPath finds the forward path consumer → hello (symbol target)', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphPath(
        withCwd(makeArgs(['path', 'packages/p/src/consumer.ts', 'hello']), root),
      );
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.found).toBe(true);
      expect(json.direction).toBe('forward');
      expect(json.hops.length).toBeGreaterThan(0);
      // Each hop carries the edge kind so the agent sees HOW they're wired.
      expect(typeof json.hops[0].kind).toBe('string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphPath reports the reverse direction when only B → A is wired', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      // index.ts does NOT import consumer.ts; consumer.ts imports index.ts.
      const code = await runGraphPath(
        withCwd(makeArgs(['path', 'packages/p/src/index.ts', 'packages/p/src/consumer.ts']), root),
      );
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.found).toBe(true);
      expect(json.direction).toBe('reverse');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphPath exits 1 with a hint when an endpoint is unknown', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphPath(
        withCwd(makeArgs(['path', 'packages/p/src/consumer.ts', 'doesNotExist']), root),
      );
      const json = JSON.parse(cap.restore());
      expect(code).toBe(1);
      expect(json.ok).toBe(false);
      expect(json.error).toBe('not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── 1.1: graph context reports true totals + a truncated flag ──────────

  test('runGraphContext emits totals with truncated=false below the cap', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphContext(
        withCwd(makeArgs(['context', 'packages/p/src/index.ts']), root),
      );
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      // index.ts is imported by exactly consumer.ts — total is honest, no truncation.
      expect(json.totalImportedBy).toBe(1);
      expect(json.importedByTruncated).toBe(false);
      expect(json.totalImportsFrom).toBe(0);
      expect(json.importsFromTruncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphContext reports the TRUE total + truncated=true for a high-fan-in file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-cli-fanin-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
      );
      mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'p', 'package.json'),
        JSON.stringify({ name: '@demo/p', main: 'src/core.ts' }, null, 2),
      );
      writeFileSync(join(root, 'packages', 'p', 'src', 'core.ts'), 'export const core = 1;\n');
      // 60 importers of core.ts — well past the 50 per-list display cap.
      const importerCount = 60;
      for (let i = 0; i < importerCount; i += 1) {
        writeFileSync(
          join(root, 'packages', 'p', 'src', `u${i}.ts`),
          `import { core } from './core.ts';\nexport const u${i} = core;\n`,
        );
      }
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphContext(
        withCwd(makeArgs(['context', 'packages/p/src/core.ts']), root),
      );
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      // The list is display-capped at 50, but the metadata stays honest.
      expect(json.importedBy.length).toBe(50);
      expect(json.totalImportedBy).toBe(importerCount);
      expect(json.importedByTruncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── 4.3: --limit N (and --limit 0 = all) on graph read commands ────────

  function fanInFixture(importerCount: number): string {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-cli-limit-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
    );
    mkdirSync(join(root, 'packages', 'p', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'p', 'package.json'),
      JSON.stringify({ name: '@demo/p', main: 'src/core.ts' }, null, 2),
    );
    writeFileSync(join(root, 'packages', 'p', 'src', 'core.ts'), 'export const core = 1;\n');
    for (let i = 0; i < importerCount; i += 1) {
      writeFileSync(
        join(root, 'packages', 'p', 'src', `u${i}.ts`),
        `import { core } from './core.ts';\nexport const u${i} = core;\n`,
      );
    }
    return root;
  }

  test('runGraphContext --limit 0 returns the full importer set (truncated=false)', async () => {
    const root = fanInFixture(60);
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const args = withCwd(makeArgs(['context', 'packages/p/src/core.ts']), root);
      args.flags.set('limit', '0');
      const cap = capture();
      const code = await runGraphContext(args);
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      // --limit 0 = all: every importer is returned and nothing is "truncated".
      expect(json.importedBy.length).toBe(60);
      expect(json.totalImportedBy).toBe(60);
      expect(json.importedByTruncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphContext --limit N caps below the default and stays honest', async () => {
    const root = fanInFixture(60);
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const args = withCwd(makeArgs(['context', 'packages/p/src/core.ts']), root);
      args.flags.set('limit', '10');
      const cap = capture();
      const code = await runGraphContext(args);
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.importedBy.length).toBe(10);
      expect(json.totalImportedBy).toBe(60);
      expect(json.importedByTruncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphCallers --limit 0 returns every caller site', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const args = withCwd(makeArgs(['callers', 'hello']), root);
      args.flags.set('limit', '0');
      const cap = capture();
      const code = await runGraphCallers(args);
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      expect(json.callers.length).toBe(json.total);
      expect(json.total).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphImpact --limit 0 reports limit:0 and never truncates', async () => {
    const root = fanInFixture(60);
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const args = withCwd(makeArgs(['impact', 'packages/p/src/core.ts']), root);
      args.flags.set('limit', '0');
      const cap = capture();
      const code = await runGraphImpact(args);
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      // 0 signals "unbounded" in the payload (JSON can't carry Infinity).
      expect(json.limit).toBe(0);
      expect(json.truncated).toBe(false);
      expect(json.directDependents.length).toBe(60);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── 6.2: no-arg subverbs reject a stray positional ─────────────────────

  test('graph status/cycles/unresolved/index reject a stray positional', async () => {
    const root = fixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      for (const [verb, run] of [
        ['status', runGraphStatus],
        ['cycles', runGraphCycles],
        ['unresolved', runGraphUnresolved],
        ['index', runGraphIndex],
      ] as const) {
        const cap = capture();
        const code = await run(withCwd(makeArgs([verb, 'bogus']), root));
        const json = JSON.parse(cap.restore());
        expect(code).toBe(2);
        expect(json.ok).toBe(false);
        expect(json.error).toBe('unexpected-argument');
        expect(json.argument).toBe('bogus');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── 6.2: hubs honours a positional scope, rejects an ambiguous one ─────

  test('runGraphHubs accepts a positional path scope', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const cap = capture();
      const code = await runGraphHubs(withCwd(makeArgs(['hubs', 'packages/p']), root));
      const json = JSON.parse(cap.restore());
      expect(code).toBe(0);
      // The positional is used as the scope (echoed back in the payload).
      expect(json.path).toBe('packages/p');
      expect(Array.isArray(json.symbols)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('runGraphHubs rejects passing both --path and a positional scope', async () => {
    const root = symbolFixture();
    try {
      capture().restore();
      await runGraphIndex(withCwd(makeArgs(['index']), root));
      const args = withCwd(makeArgs(['hubs', 'packages/p']), root);
      args.flags.set('path', 'packages/q');
      const cap = capture();
      const code = await runGraphHubs(args);
      const json = JSON.parse(cap.restore());
      expect(code).toBe(2);
      expect(json.ok).toBe(false);
      expect(json.error).toBe('ambiguous-path');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function withCwd<T extends { flags: Map<string, string | boolean> }>(args: T, cwd: string): T {
  args.flags.set('cwd', cwd);
  return args;
}
