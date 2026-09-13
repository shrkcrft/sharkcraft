/**
 * Round 12 (R12-5.5) — the MCP boundary-rule reads carry the EFFECTIVE
 * semantics, from the one authority the evaluator and `boundaries explain`
 * read.
 *
 * `list_boundary_rules` omitted `forbiddenMatch` and re-implemented the unset
 * severity default inline (`r.severity ?? 'error'`); `get_boundary_rule`
 * returned the raw rule. For the consumer's shape (no severity, no
 * forbiddenMatch) an agent reading the fence over MCP could not tell that
 * `@scope/pkg` also forbids `@scope/pkg/sub`, or tell a package rule from an
 * `exact` opt-out. Output-only — the input schemas are unchanged.
 *
 * A real temp workspace with a real sharkcraft/boundaries.ts, a real inspection
 * (`inspectSharkcraft`) and the real registered handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  boundaryForbiddenMatch,
  boundaryRuleFailsOnEmpty,
  boundaryRuleSeverity,
  type IBoundaryRule,
} from '@shrkcrft/boundaries';
import { expandColumnar, isColumnarTable } from '@shrkcrft/compress';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '../tools/all-tools.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
};

/** A plain rule (the consumer's shape), an exact opt-out, a warning rule, and enough siblings for a columnar table to win. */
const RULES: readonly Record<string, unknown>[] = [
  { id: 'app.no-scope-pkg', title: 'No pkg', from: ['packages/app/**'], forbiddenImports: ['@scope/pkg', '@scope/pkg-*'] },
  { id: 'app.barrel-lodash', title: 'No lodash barrel', from: ['packages/app/**'], forbiddenImports: ['lodash'], forbiddenMatch: 'exact' },
  { id: 'app.soft', title: 'Soft fence', severity: 'warning', from: ['packages/app/**'], forbiddenImports: ['@scope/soft'] },
  {
    id: 'app.helper-shape',
    title: 'Helper shape',
    from: ['packages/app/**'],
    forbiddenImports: ['@scope/pkg', '@scope/pkg/**'],
    allowedImports: ['@scope/pkg/public/**', 'react'],
  },
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `filler.rule-${i}`,
    title: `Filler ${i}`,
    from: ['packages/app/**'],
    forbiddenImports: [`@filler/pkg-${i}`],
  })),
];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-mcp-boundary-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'sharkcraft/boundaries.ts': `export default ${JSON.stringify(RULES, null, 2)};\n`,
    'packages/app/src/x.ts': "import r from 'react';\nexport const x = r;\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe('list_boundary_rules / get_boundary_rule report the effective semantics', () => {
  test('every list row carries forbiddenMatch and severity from the one authority — json and table alike', async () => {
    const root = workspace();
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(inspection.boundaryRegistry.size()).toBe(RULES.length);
    const ctx = { inspection, cwd: root };
    const expected = inspection.boundaryRegistry
      .list()
      .map((r: IBoundaryRule) => [r.id, boundaryForbiddenMatch(r), boundaryRuleSeverity(r)]);
    // Spot-check the authority's answers so the comparison is not vacuous.
    expect(expected.filter(([id]) => ['app.no-scope-pkg', 'app.barrel-lodash', 'app.soft'].includes(id as string))).toEqual([
      ['app.no-scope-pkg', 'package', 'error'],
      ['app.barrel-lodash', 'exact', 'error'],
      ['app.soft', 'package', 'warning'],
    ]);

    const json = (await tool('list_boundary_rules').handler({ format: 'json' }, ctx)).data as Record<string, unknown>[];
    expect(json.map((r) => [r.id, r.forbiddenMatch, r.severity])).toEqual(expected);

    const table = (await tool('list_boundary_rules').handler({ format: 'table' }, ctx)).data as { format?: string; items?: unknown };
    expect(table.format).toBe('table');
    expect(isColumnarTable(table.items)).toBe(true);
    const rebuilt = expandColumnar(table.items as Parameters<typeof expandColumnar>[0]);
    expect(rebuilt.map((r) => [r.id, r.forbiddenMatch, r.severity])).toEqual(expected);
  }, 30_000);

  test('get_boundary_rule adds the effective severity / forbiddenMatch / failOnEmpty and the overlap report to the rule as written', async () => {
    const root = workspace();
    const inspection = await inspectSharkcraft({ cwd: root });
    const ctx = { inspection, cwd: root };
    for (const id of ['app.no-scope-pkg', 'app.barrel-lodash', 'app.soft']) {
      const rule = inspection.boundaryRegistry.get(id)!;
      const data = (await tool('get_boundary_rule').handler({ id }, ctx)).data as Record<string, unknown>;
      expect([data.id, data.severity, data.forbiddenMatch, data.failOnEmpty]).toEqual([
        id,
        boundaryRuleSeverity(rule),
        boundaryForbiddenMatch(rule),
        boundaryRuleFailsOnEmpty(rule),
      ]);
      expect(data.forbiddenImports).toEqual(rule.forbiddenImports);
      expect((data.source as { type?: string } | null)?.type).toBe('local');
    }
    const helper = (await tool('get_boundary_rule').handler({ id: 'app.helper-shape' }, ctx)).data as Record<string, unknown>;
    expect(helper.redundantForbidden).toEqual([{ pattern: '@scope/pkg/**', coveredBy: '@scope/pkg' }]);
    expect(helper.shadowedAllowed).toEqual([{ pattern: '@scope/pkg/public/**', shadowedBy: '@scope/pkg' }]);
    const missing = await tool('get_boundary_rule').handler({ id: 'nope' }, ctx);
    expect(missing.isError).toBe(true);
  }, 30_000);

  test('the input schemas are unchanged (output-only change — the strict wire validator needs no edit)', () => {
    expect(tool('list_boundary_rules').inputSchema).toEqual({
      type: 'object',
      properties: { format: expect.any(Object) },
      additionalProperties: false,
    });
    expect(tool('get_boundary_rule').inputSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    });
  });
});
