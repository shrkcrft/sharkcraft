import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { isColumnarTable, expandColumnar } from '@shrkcrft/compress';
import { ALL_TOOLS } from '../tools/index.ts';

const R65_TOOLS = [
  'get_graph_status',
  'get_graph_search',
  'get_graph_context',
  'get_graph_impact',
  'get_graph_callers',
] as const;

function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-graph-mcp-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }, null, 2),
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
    "export const ALPHA_TAG = 'alpha';\nexport function alpha() { return ALPHA_TAG; }",
  );
  writeFileSync(
    join(root, 'packages', 'beta', 'src', 'index.ts'),
    "import { alpha } from '@demo/alpha';\nexport function useAlpha() { return alpha(); }",
  );
  return root;
}

async function ctxFor(root: string) {
  const inspection = await inspectSharkcraft({ cwd: root });
  return { cwd: root, inspection };
}

describe('r65 graph mcp tools', () => {
  test('all expected MCP tools are registered', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const expected of R65_TOOLS) {
      expect(names).toContain(expected);
    }
  });

  test('graph tools advertise read-only intent', () => {
    for (const name of R65_TOOLS) {
      const tool = ALL_TOOLS.find((t) => t.name === name)!;
      expect(tool.description.toLowerCase()).toContain('read-only');
    }
  });

  test('graph tools mirror a CLI sibling via cliCommand', () => {
    for (const name of R65_TOOLS) {
      const tool = ALL_TOOLS.find((t) => t.name === name)!;
      expect(tool.cliCommand?.startsWith('graph ')).toBe(true);
    }
  });

  test('get_graph_status returns nextCommand when index is missing', async () => {
    const root = setupFixture();
    try {
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_status')!;
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe('graph-missing');
      expect((result.error?.details as { nextCommand: string }).nextCommand).toBe(
        'shrk graph index',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_status returns fresh state after buildFullIndex', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_status')!;
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as { state: string; fileCount: number; schema: string };
      expect(data.state).toBe('fresh');
      expect(data.schema).toBe('sharkcraft.graph/v1');
      expect(data.fileCount).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_search finds a known symbol', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_search')!;
      const result = await tool.handler({ query: 'useAlpha', kind: 'symbol' }, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as { total: number; matches: { label: string; path: string }[] };
      expect(data.total).toBeGreaterThanOrEqual(1);
      expect(data.matches.some((m) => m.label === 'useAlpha')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_context returns symbols and imports for a file anchor', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_context')!;
      const result = await tool.handler(
        { target: 'packages/beta/src/index.ts' },
        ctx as never,
      );
      expect(result.isError).not.toBe(true);
      const data = result.data as {
        anchor: { path: string };
        symbols: { label: string }[];
        importsFrom: { resolved: boolean; path?: string }[];
      };
      expect(data.anchor.path).toBe('packages/beta/src/index.ts');
      expect(data.symbols.some((s) => s.label === 'useAlpha')).toBe(true);
      const resolvedImports = data.importsFrom.filter((i) => i.resolved);
      expect(resolvedImports.some((i) => i.path === 'packages/alpha/src/index.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_impact reports direct + transitive dependents', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_impact')!;
      const result = await tool.handler(
        { target: 'packages/alpha/src/index.ts' },
        ctx as never,
      );
      expect(result.isError).not.toBe(true);
      const data = result.data as {
        directDependents: { path: string }[];
        totalReached: number;
      };
      expect(data.directDependents.some((d) => d.path === 'packages/beta/src/index.ts')).toBe(true);
      expect(data.totalReached).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_callers reports callers of a function (call mode)', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_callers')!;
      const result = await tool.handler({ symbol: 'alpha', mode: 'call' }, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as { total: number; callers: { path: string }[] };
      expect(data.total).toBeGreaterThanOrEqual(1);
      expect(data.callers.some((c) => c.path === 'packages/beta/src/index.ts')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_context returns not-found for an unknown target', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_context')!;
      const result = await tool.handler({ target: 'no-such-symbol-anywhere' }, ctx as never);
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe('not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_cycles returns nextCommand when index is missing', async () => {
    const root = setupFixture();
    try {
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_cycles')!;
      expect(tool).toBeDefined();
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe('graph-missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_cycles returns the full cycle list after index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-mcp-cycles-'));
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
      writeFileSync(join(root, 'packages', 'p', 'src', 'b.ts'), "import './a.ts'; export const b = 1;");
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_cycles')!;
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as {
        schema: string;
        total: number;
        cycles: { size: number; paths: string[] }[];
      };
      expect(data.schema).toBe('sharkcraft.graph-cycles/v1');
      expect(data.total).toBe(1);
      expect(data.cycles[0]?.size).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_unresolved returns nextCommand when index is missing', async () => {
    const root = setupFixture();
    try {
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_unresolved')!;
      expect(tool).toBeDefined();
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe('graph-missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_unresolved groups unresolved imports by file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-mcp-unresolved-'));
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
        "import './missing'; import './also-missing';",
      );
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_unresolved')!;
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as {
        schema: string;
        totalEdges: number;
        totalFiles: number;
        files: { path: string; unresolved: string[] }[];
      };
      expect(data.schema).toBe('sharkcraft.graph-unresolved/v1');
      expect(data.totalEdges).toBe(2);
      expect(data.totalFiles).toBe(1);
      expect(data.files[0]?.unresolved.sort()).toEqual([
        './also-missing',
        './missing',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_unresolved honours format json vs table (mode-explicit)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-mcp-unresolved-fmt-'));
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
      // Two distinct source files, each with unresolved imports, so the outer
      // `files` array clears the columnar minimum-rows gate.
      writeFileSync(
        join(root, 'packages', 'p', 'src', 'a.ts'),
        "import './missing-a1'; import './missing-a2';",
      );
      writeFileSync(
        join(root, 'packages', 'p', 'src', 'b.ts'),
        "import './missing-b1';",
      );
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_unresolved')!;

      // Tool advertises the format switch.
      expect(
        (tool.inputSchema.properties as Record<string, unknown>).format,
      ).toBeDefined();

      // format:"json" → the explicit object shape, files is a bare array.
      const jsonRes = await tool.handler({ format: 'json' }, ctx as never);
      expect(jsonRes.isError).not.toBe(true);
      const jd = jsonRes.data as {
        schema: string;
        totalFiles: number;
        files: { path: string; unresolved: string[] }[];
      };
      expect(jd.schema).toBe('sharkcraft.graph-unresolved/v1');
      expect(Array.isArray(jd.files)).toBe(true);
      expect(jd.totalFiles).toBe(2);

      // format:"table" → scalars preserved; `files` columnarised when hoisting
      // saves tokens, or kept bare under the net-loss guard (this 2-row list is
      // small). Either way it reconstructs to the json-mode array.
      const tableRes = await tool.handler({ format: 'table' }, ctx as never);
      expect(tableRes.isError).not.toBe(true);
      const td = tableRes.data as Record<string, unknown>;
      expect(td.schema).toBe('sharkcraft.graph-unresolved/v1'); // scalar untouched
      expect(td.totalFiles).toBe(2); // scalar untouched
      const files = isColumnarTable(td.files) ? expandColumnar(td.files as never) : td.files;
      expect(files).toEqual(jd.files);
      // Still valid JSON.
      JSON.parse(JSON.stringify(td));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_deps returns inbound + outbound for a workspace package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-graph-mcp-deps-'));
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
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_deps')!;
      const result = await tool.handler({ package: '@demo/beta' }, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as {
        schema: string;
        package: string;
        dependsOn: string[];
        dependedOnBy: string[];
      };
      expect(data.schema).toBe('sharkcraft.graph-deps/v1');
      expect(data.dependsOn).toContain('@demo/alpha');
      expect(data.dependedOnBy).toContain('@demo/gamma');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_graph_deps returns not-found for an unknown package', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const tool = ALL_TOOLS.find((t) => t.name === 'get_graph_deps')!;
      const result = await tool.handler({ package: '@nope/not-real' }, ctx as never);
      expect(result.isError).toBe(true);
      expect(result.error?.code).toBe('not-found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('round-6 read-only MCP tools', () => {
  test('get_impact_baseline reports missing-both when no state files exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-ib-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'demo', workspaces: ['packages/*'] }, null, 2),
      );
      const ctx = { cwd: root, inspection: { projectRoot: root } };
      const tool = ALL_TOOLS.find((t) => t.name === 'get_impact_baseline')!;
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as { state: string };
      expect(data.state).toBe('missing-both');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_pattern_registry is silent (present: false) when no registry exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-pat-'));
    try {
      const ctx = { cwd: root, inspection: { projectRoot: root } };
      const tool = ALL_TOOLS.find((t) => t.name === 'get_pattern_registry')!;
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as { present: boolean; patterns: unknown[] };
      expect(data.present).toBe(false);
      expect(data.patterns).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_pattern_registry returns the seeded set after add', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-pat-seeded-'));
    try {
      mkdirSync(join(root, '.sharkcraft', 'structural'), { recursive: true });
      writeFileSync(
        join(root, '.sharkcraft', 'structural', 'patterns.json'),
        JSON.stringify({
          schema: 'sharkcraft.structural-pattern-registry/v1',
          patterns: [
            {
              id: 'p',
              pattern: { kind: 'Decorator', name: 'Controller' },
              addedAt: new Date().toISOString(),
              lastValidatedAt: new Date().toISOString(),
            },
          ],
        }),
      );
      const ctx = { cwd: root, inspection: { projectRoot: root } };
      const tool = ALL_TOOLS.find((t) => t.name === 'get_pattern_registry')!;
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as { present: boolean; total: number };
      expect(data.present).toBe(true);
      expect(data.total).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_intent_benchmark_run reports missing when neither fixture nor run exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-ib-run-'));
    try {
      const ctx = { cwd: root, inspection: { projectRoot: root } };
      const tool = ALL_TOOLS.find((t) => t.name === 'get_intent_benchmark_run')!;
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as { state: string };
      expect(data.state).toBe('missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_intent_benchmark_run reports fixture-only when only the fixture exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-ib-fix-'));
    try {
      mkdirSync(join(root, 'sharkcraft'), { recursive: true });
      writeFileSync(
        join(root, 'sharkcraft', 'intent-benchmark.json'),
        JSON.stringify({
          schema: 'sharkcraft.intent-benchmark/v1',
          cases: [{ task: 'fix the login bug', expected: 'bug-fix' }],
        }),
      );
      const ctx = { cwd: root, inspection: { projectRoot: root } };
      const tool = ALL_TOOLS.find((t) => t.name === 'get_intent_benchmark_run')!;
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as { state: string; fixtureCaseCount: number };
      expect(data.state).toBe('fixture-only');
      expect(data.fixtureCaseCount).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('round-6 tools are registered and advertise read-only intent', () => {
    const expected = [
      'get_graph_deps',
      'get_impact_baseline',
      'get_pattern_registry',
      'get_intent_benchmark_run',
    ];
    for (const name of expected) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      expect(tool, `tool "${name}" must be registered`).toBeDefined();
      expect(tool!.description.toLowerCase()).toContain('read-only');
    }
  });

  test('get_code_intelligence_state returns the full check set in one shot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-ci-state-'));
    try {
      mkdirSync(join(root, '.sharkcraft', 'graph'), { recursive: true });
      writeFileSync(
        join(root, '.sharkcraft', 'graph', 'meta.json'),
        JSON.stringify({
          schema: 'sharkcraft.graph/v1',
          lastIndexedAt: new Date().toISOString(),
          filesIndexed: 1,
          nodesByKind: { file: 1 },
          edgesByKind: {},
        }),
      );
      const ctx = { cwd: root, inspection: { projectRoot: root } };
      const tool = ALL_TOOLS.find((t) => t.name === 'get_code_intelligence_state')!;
      expect(tool).toBeDefined();
      const result = await tool.handler({}, ctx as never);
      expect(result.isError).not.toBe(true);
      const data = result.data as {
        schema: string;
        totalChecks: number;
        summary: { ok: number };
        checks: { id: string }[];
      };
      expect(data.schema).toBe('sharkcraft.code-intelligence-state/v1');
      expect(data.totalChecks).toBeGreaterThanOrEqual(1);
      expect(data.summary.ok).toBeGreaterThanOrEqual(1);
      expect(data.checks.some((c) => c.id === 'code-intelligence-graph')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('get_code_intelligence_state honours checkId + only filters', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-mcp-ci-state-filter-'));
    try {
      mkdirSync(join(root, '.sharkcraft', 'graph'), { recursive: true });
      writeFileSync(
        join(root, '.sharkcraft', 'graph', 'meta.json'),
        JSON.stringify({
          schema: 'sharkcraft.graph/v1',
          lastIndexedAt: new Date().toISOString(),
          filesIndexed: 1,
          nodesByKind: { file: 1 },
          edgesByKind: {},
        }),
      );
      const ctx = { cwd: root, inspection: { projectRoot: root } };
      const tool = ALL_TOOLS.find((t) => t.name === 'get_code_intelligence_state')!;
      const result = await tool.handler(
        { checkId: 'code-intelligence-graph', only: ['ok'] },
        ctx as never,
      );
      const data = result.data as { totalChecks: number; checks: { id: string; severity: string }[] };
      expect(data.totalChecks).toBe(1);
      expect(data.checks[0]?.id).toBe('code-intelligence-graph');
      expect(data.checks[0]?.severity).toBe('ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
