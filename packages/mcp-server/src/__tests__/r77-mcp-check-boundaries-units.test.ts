/**
 * r77 — MCP boundary tools and `expectEmpty` (round 13; DECISIONS §6 lane B;
 * DESIGN-D1 tests item 9).
 *
 *   - `check_boundaries` takes `failOnDeadUnits` — declared in BOTH the
 *     advertised inputSchema and the strict wire validator (which must keep
 *     declaring `ruleId`, the tool's original input) — and every call here goes
 *     THROUGH `validateToolInput` first, never the bare handler alone (the
 *     dual-schema gotcha: a handler test bypasses the validator);
 *   - its output carries each unit's state: `intendedEmpty`, `wentLive`,
 *     `failingUnits`, `accepted`, and the dead units worded by the one causes
 *     sentence (`DEAD_SELECTOR_CAUSES`);
 *   - `get_boundary_rule` / `list_boundary_rules` keep the pattern lists'
 *     string[] wire shape and add `expectEmptyUnits` (+ the 'intended empty' line).
 *
 * Real temp workspaces through the real inspector.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEAD_SELECTOR_CAUSES } from '@shrkcrft/core';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { TOOL_INPUT_SCHEMAS, validateToolInput } from '../server/tool-input-validators.ts';
import { checkBoundariesTool } from '../tools/check-boundaries.tool.ts';
import { getBoundaryRuleTool } from '../tools/get-boundary-rule.tool.ts';
import { listBoundaryRulesTool } from '../tools/list-boundary-rules.tool.ts';

const SLOW = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const MARKED = `export default [{ id: 'layer.no-imports-up', title: 'No imports up', from: ['packages/app/**'],
  forbiddenImports: ['@scope/kernel-*', { pattern: '@scope/plugin-react', expectEmpty: true, reason: 'ADR-7: planned binding' }, { pattern: '@scope/kernel', expectEmpty: true }] }];\n`;
const UNMARKED = `export default [{ id: 'layer.no-imports-up', title: 'No imports up', from: ['packages/app/**'],
  forbiddenImports: ['@scope/kernel-*', '@scope/plugin-react', '@scope/kernel'] }];\n`;

/** The facts-V1 fxB shape: the app imports only `@scope/util`; `@scope/kernel-a` is a workspace package. */
function fx(rules: string, extra: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-mcp-boundaries-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', private: true }),
    'packages/app/package.json': JSON.stringify({ name: '@scope/app', version: '0.0.0' }),
    'packages/app/src/x.ts': "import { u } from '@scope/util';\nexport const x = u;\n",
    'packages/kernel-a/package.json': JSON.stringify({ name: '@scope/kernel-a', version: '0.0.0' }),
    'packages/kernel-a/src/index.ts': 'export const k = 1;\n',
    'packages/util/package.json': JSON.stringify({ name: '@scope/util', version: '0.0.0' }),
    'packages/util/src/index.ts': 'export const u = 1;\n',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'sharkcraft/boundaries.ts': rules,
    ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

interface IUnitRow {
  readonly ruleId: string;
  readonly unit: string;
  readonly selector: string;
  readonly state: string;
  readonly reason: string;
  readonly markReason?: string;
}

interface ICheckData {
  readonly exitCode: number;
  readonly verdict: string;
  readonly deadUnits: readonly { readonly selector: string; readonly reason: string }[];
  readonly intendedEmpty: readonly IUnitRow[];
  readonly wentLive: readonly IUnitRow[];
  readonly failingUnits: readonly IUnitRow[];
  readonly accepted: readonly string[];
  readonly coverage: readonly { readonly forbidden: readonly { readonly pattern: string; readonly state?: string }[] }[];
}

/** Validate on the wire FIRST (as the server does), then call the handler with what the validator returned. */
async function callCheck(root: string, input: Record<string, unknown>): Promise<ICheckData> {
  const v = validateToolInput('check_boundaries', input);
  if (!v.ok) throw new Error(`rejected on the wire: ${v.failure.message}`);
  const inspection = await inspectSharkcraft({ cwd: root });
  const res = await checkBoundariesTool.handler(v.data as Record<string, unknown>, { inspection, cwd: root } as never);
  return res.data as ICheckData;
}

describe('check_boundaries — the failOnDeadUnits input on the wire', () => {
  test('the inputSchema and the strict zod validator declare the same inputs — ruleId kept', () => {
    const props = checkBoundariesTool.inputSchema.properties as Record<string, { type?: string }>;
    expect(Object.keys(props).sort()).toEqual(['failOnDeadUnits', 'ruleId']);
    expect(props['failOnDeadUnits']?.type).toBe('boolean');
    expect(checkBoundariesTool.inputSchema.additionalProperties).toBe(false);
    expect(TOOL_INPUT_SCHEMAS['check_boundaries']).toBeDefined();
    expect(validateToolInput('check_boundaries', {}).ok).toBe(true);
    expect(validateToolInput('check_boundaries', { ruleId: 'layer.no-imports-up' }).ok).toBe(true);
    expect(validateToolInput('check_boundaries', { failOnDeadUnits: true }).ok).toBe(true);
    expect(validateToolInput('check_boundaries', { ruleId: 'x', failOnDeadUnits: false }).ok).toBe(true);
    expect(validateToolInput('check_boundaries', { failOnDeadUnits: 'yes' }).ok).toBe(false);
    expect(validateToolInput('check_boundaries', { strict: true }).ok).toBe(false);
  });

  test(
    'an unmarked planned target: dead, worded by DEAD_SELECTOR_CAUSES; failOnDeadUnits turns it into 1',
    async () => {
      const root = fx(UNMARKED);
      const plain = await callCheck(root, {});
      expect(plain.exitCode).toBe(0);
      expect(plain.deadUnits.map((d) => d.selector).sort()).toEqual(['@scope/kernel', '@scope/plugin-react']);
      for (const d of plain.deadUnits) {
        expect(d.reason).toBe(
          `matches no import anywhere in the repo, no workspace/dependency package name, no tsconfig alias and no file — ${DEAD_SELECTOR_CAUSES}`,
        );
      }
      const strict = await callCheck(root, { failOnDeadUnits: true });
      expect(strict.exitCode).toBe(1);
      expect(strict.failingUnits.map((u) => [u.selector, u.state]).sort()).toEqual([
        ['@scope/kernel', 'dead'],
        ['@scope/plugin-react', 'dead'],
      ]);
    },
    SLOW,
  );

  test(
    'marked: intended-empty, accepted, no dead unit — and failOnDeadUnits stays 0',
    async () => {
      const root = fx(MARKED);
      for (const input of [{}, { failOnDeadUnits: true }]) {
        const data = await callCheck(root, input);
        expect(data.exitCode).toBe(0);
        expect(data.deadUnits).toEqual([]);
        expect(data.failingUnits).toEqual([]);
        expect(data.intendedEmpty.map((u) => u.selector).sort()).toEqual(['@scope/kernel', '@scope/plugin-react']);
        expect(data.intendedEmpty.find((u) => u.selector === '@scope/plugin-react')?.markReason).toBe('ADR-7: planned binding');
        expect(data.accepted.join('\n')).toContain('layer.no-imports-up: accepted by expectEmpty: examined 0 of 2 selector units');
        expect(data.coverage[0]!.forbidden.map((f) => [f.pattern, f.state])).toEqual([
          ['@scope/kernel-*', 'live'],
          ['@scope/plugin-react', 'intended-empty'],
          ['@scope/kernel', 'intended-empty'],
        ]);
      }
    },
    SLOW,
  );

  test(
    'went live (the planned package now exists): reported, exit unchanged — and failOnDeadUnits fails the LOCAL marker',
    async () => {
      const root = fx(MARKED, {
        'packages/plugin-react/package.json': JSON.stringify({ name: '@scope/plugin-react', version: '0.0.0' }),
      });
      const plain = await callCheck(root, {});
      expect(plain.exitCode).toBe(0);
      expect(plain.wentLive.map((u) => [u.selector, u.state])).toEqual([['@scope/plugin-react', 'went-live']]);
      expect(plain.wentLive[0]!.reason).toContain('expectEmpty is stale');
      expect(plain.wentLive[0]!.reason).toContain('the fence went live; remove expectEmpty');
      const failing = await callCheck(root, { failOnDeadUnits: true });
      expect(failing.exitCode).toBe(1);
      expect(failing.failingUnits.map((u) => [u.selector, u.state])).toEqual([['@scope/plugin-react', 'went-live']]);
    },
    SLOW,
  );
});

describe('get_boundary_rule / list_boundary_rules — the markers, the wire shape unchanged', () => {
  test(
    'expectEmptyUnits and the intended-empty line; the pattern lists stay string[]',
    async () => {
      const root = fx(MARKED);
      const inspection = await inspectSharkcraft({ cwd: root });
      const ctx = { inspection, cwd: root } as never;
      const got = (await getBoundaryRuleTool.handler({ id: 'layer.no-imports-up' }, ctx)).data as {
        forbiddenImports: readonly unknown[];
        expectEmptyUnits: readonly { list: string; unit: string; reason?: string }[];
        expectEmptyMarkers: readonly string[];
      };
      expect(got.forbiddenImports).toEqual(['@scope/kernel-*', '@scope/plugin-react', '@scope/kernel']);
      expect(got.expectEmptyUnits).toEqual([
        { list: 'forbiddenImports', unit: '@scope/plugin-react', reason: 'ADR-7: planned binding' },
        { list: 'forbiddenImports', unit: '@scope/kernel' },
      ]);
      // A DECLARATION, never a state (round 13 review): the static rule view
      // cannot know whether a marker went live — `check_boundaries` settles it.
      expect(got.expectEmptyMarkers).toEqual([
        'expectEmpty marker: forbiddenImports @scope/plugin-react — ADR-7: planned binding (state: see check_boundaries)',
        'expectEmpty marker: forbiddenImports @scope/kernel — no reason given (state: see check_boundaries)',
      ]);
      expect(Object.keys(got)).not.toContain('intendedEmpty');
      const listed = (await listBoundaryRulesTool.handler({}, ctx)).data as readonly {
        id: string;
        forbiddenImports: readonly unknown[];
        expectEmptyUnits: readonly unknown[];
      }[];
      const row = listed.find((r) => r.id === 'layer.no-imports-up')!;
      expect(row.forbiddenImports.every((p) => typeof p === 'string')).toBe(true);
      expect(row.expectEmptyUnits).toHaveLength(2);
    },
    SLOW,
  );
});

/** The rule counts `check boundaries --json` carries — MCP returns the same keys. */
interface IRuleCounts {
  readonly rulesEvaluated?: number;
  readonly rulesAcceptedEmpty?: number;
}

describe('check_boundaries — rulesAcceptedEmpty, the `check boundaries --json` key (K6)', () => {
  test(
    'a rule accepted as intended-empty is counted apart from rulesEvaluated; a run with no rules carries rulesAcceptedEmpty: 0',
    async () => {
      const root = fx(`export default [
  { id: 'app.no-kernel', title: 'app', from: ['packages/app/**'], forbiddenImports: ['@scope/kernel-*'] },
  { id: 'plugins.no-kernel', title: 'plugins', from: [{ pattern: 'packages/plugin-react/**', expectEmpty: true }], forbiddenImports: ['@scope/kernel-*'] },
];\n`);
      // Through the wire validator first (callCheck), as the server does.
      const data = (await callCheck(root, {})) as ICheckData & IRuleCounts;
      expect(data.exitCode).toBe(0);
      expect([data.rulesEvaluated, data.rulesAcceptedEmpty]).toEqual([1, 1]);
      expect(data.accepted.join('\n')).toContain('plugins.no-kernel: accepted by expectEmpty');
      const none = (await callCheck(fx('export default [];\n'), {})) as ICheckData & IRuleCounts;
      expect([none.rulesEvaluated, none.rulesAcceptedEmpty]).toEqual([0, 0]);
    },
    SLOW,
  );
});
