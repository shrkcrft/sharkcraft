import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFullIndex, GraphStore } from '@shrkcrft/graph';
import { extractApiSurface, type IApiSurface } from '@shrkcrft/api-surface-diff';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/index.ts';

/**
 * `get_api_surface_diff` is the read-only MCP sibling of `shrk api-diff`. It
 * diffs a caller-supplied baseline against the LIVE code-graph surface; it must
 * never write. The fixture package exports three symbols.
 */
function setupFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-api-diff-tool-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-root', workspaces: ['packages/*'] }),
  );
  mkdirSync(join(root, 'packages', 'alpha', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'alpha', 'package.json'),
    JSON.stringify({ name: '@demo/alpha', main: 'src/index.ts' }),
  );
  writeFileSync(
    join(root, 'packages', 'alpha', 'src', 'index.ts'),
    'export function shared() { return 1; }\nexport function doomed() { return 2; }\nexport const C = 3;\n',
  );
  return root;
}

async function ctxFor(root: string) {
  return { cwd: root, inspection: await inspectSharkcraft({ cwd: root }) };
}

/** The live surface captured from the indexed graph store. */
function liveSurface(root: string): IApiSurface {
  return extractApiSurface(new GraphStore(root).loadSnapshot());
}

const tool = () => ALL_TOOLS.find((t) => t.name === 'get_api_surface_diff')!;

type ErrRes = { isError?: boolean; error?: { code: string; message: string } };
type DataRes = {
  data: {
    schema: string;
    baselineTotal: number;
    currentTotal: number;
    added: number;
    removed: number;
    changed: number;
    breakingCount: number;
    entries: Array<{ kind: string; severity: string; symbol: { name: string } }>;
  };
};

describe('get_api_surface_diff MCP tool', () => {
  test('is registered, read-only, mirrors the CLI sibling', () => {
    const t = tool();
    expect(t).toBeDefined();
    expect(t.description.toLowerCase()).toContain('read-only');
    expect(t.cliCommand).toBe('api-diff');
  });

  test('errors when the graph index is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shrk-api-diff-tool-empty-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
      const ctx = await ctxFor(root);
      // A baseline IS supplied, so the error is specifically about the graph.
      const baseline: IApiSurface = {
        schema: 'sharkcraft.api-surface/v1',
        symbols: [],
        countsByPackage: {},
        total: 0,
      };
      const res = (await tool().handler({ baseline }, ctx)) as ErrRes;
      expect(res.isError).toBe(true);
      expect(res.error?.code).toBe('graph-missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('errors when no baseline is provided (graph present)', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const res = (await tool().handler({}, ctx)) as ErrRes;
      expect(res.isError).toBe(true);
      expect(res.error?.code).toBe('invalid-input');
      expect(res.error?.message.toLowerCase()).toContain('baseline');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('errors when baselinePath is unreadable', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const res = (await tool().handler(
        { baselinePath: join(root, 'missing.json') },
        ctx,
      )) as ErrRes;
      expect(res.isError).toBe(true);
      expect(res.error?.code).toBe('invalid-input');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('inline baseline identical to the live surface → well-formed no-change diff', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const baseline = liveSurface(root);
      expect(baseline.total).toBe(3);
      const res = (await tool().handler({ baseline }, ctx)) as DataRes;
      expect(res.data.schema).toBe('sharkcraft.api-surface-diff/v1');
      expect(res.data.baselineTotal).toBe(3);
      expect(res.data.currentTotal).toBe(3);
      expect(res.data.added).toBe(0);
      expect(res.data.removed).toBe(0);
      expect(res.data.changed).toBe(0);
      expect(res.data.breakingCount).toBe(0);
      expect(res.data.entries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('inline baseline missing a symbol → diff reports it as added (additive)', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const live = liveSurface(root);
      // Baseline lacks `doomed`; the live surface still has it → it's "added"
      // relative to the baseline.
      const baseline: IApiSurface = {
        ...live,
        symbols: live.symbols.filter((s) => s.name !== 'doomed'),
        total: live.total - 1,
      };
      const res = (await tool().handler({ baseline }, ctx)) as DataRes;
      expect(res.data.baselineTotal).toBe(2);
      expect(res.data.currentTotal).toBe(3);
      expect(res.data.added).toBe(1);
      expect(res.data.removed).toBe(0);
      const addedEntry = res.data.entries.find((e) => e.kind === 'added');
      expect(addedEntry?.severity).toBe('additive');
      expect(addedEntry?.symbol.name).toBe('doomed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('baselinePath loads a captured surface from disk (read-only file input)', async () => {
    const root = setupFixture();
    try {
      buildFullIndex({ projectRoot: root });
      const ctx = await ctxFor(root);
      const baselineFile = join(root, 'baseline.json');
      writeFileSync(baselineFile, JSON.stringify(liveSurface(root)), 'utf8');
      const res = (await tool().handler({ baselinePath: baselineFile }, ctx)) as DataRes;
      expect(res.data.schema).toBe('sharkcraft.api-surface-diff/v1');
      expect(res.data.added).toBe(0);
      expect(res.data.removed).toBe(0);
      expect(res.data.entries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
