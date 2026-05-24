import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGraphContext,
  runGraphCycles,
  runGraphDeps,
  runGraphImpact,
  runGraphIndex,
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
});

function withCwd<T extends { flags: Map<string, string | boolean> }>(args: T, cwd: string): T {
  args.flags.set('cwd', cwd);
  return args;
}
