/**
 * r75 — `shrk gate` and MCP `get_quality_gate` run ONE gate set and settle ONE
 * verdict; the knowledge-symbol gate agrees with `knowledge stale-check`
 * (round 11 review R11-COV-3 / R11-COV-4).
 *
 *   - the MCP tool passed the impact options only, so it never loaded the
 *     project's wiring / policy rules or the knowledge inspection: "No wiring
 *     rules configured" over a failing rule, `overall: pass` where `shrk gate`
 *     exited 1. Both now call `prepareQualityGateRun` + `settleQualityGateReport`.
 *   - the knowledge-symbol gate counted unknown (unpinned) and malformed
 *     references as "resolve" and passed where the stale-check said 2. It now
 *     settles on the stale-check's own fold (`declaredReferenceCoverage`).
 *
 * Real temp projects, the real handlers and the registered MCP tool.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import type { ParsedArgs } from '../command-registry.ts';
import { gateCommand } from '../commands/gate.command.ts';
import { runGraphIndex, runGraphStatus } from '../commands/graph-code-subverbs.ts';
import { knowledgeStaleCheckCommand } from '../commands/knowledge.command.ts';

const SLOW = 120_000;
/** Every gate but the one under test — no code-graph index is needed. */
const OTHERS = ['graph-fresh', 'arch', 'impact', 'graph-cycles', 'graph-unresolved', 'impact-baseline', 'structural-patterns', 'intent-classifier'];

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(
  h: { run(a: ParsedArgs): Promise<number> | number },
  a: ParsedArgs,
): Promise<{ code: number; out: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-gparity-'));
  roots.push(root);
  const all = { 'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }), ...files };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function tool(name: string): (typeof ALL_TOOLS)[number] {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
}

interface IGateJson {
  exitCode: number;
  verdict: string;
  gates: { id: string; status: string; message: string }[];
}

async function cliAndMcp(root: string, disable: readonly string[]): Promise<{ cli: IGateJson & { code: number }; mcp: IGateJson }> {
  const r = await run(gateCommand, args(root, [], { json: true, 'no-persist': true, disable: disable.join(',') }));
  const cli = { ...(JSON.parse(r.out) as IGateJson), code: r.code };
  const inspection = await inspectSharkcraft({ cwd: root });
  const mcp = (await tool('get_quality_gate').handler({ disable: [...disable] }, { inspection, cwd: root })).data as IGateJson;
  return { cli, mcp };
}

describe('`shrk gate` ≡ MCP get_quality_gate (R11-COV-3)', () => {
  test('a failing wiring rule: both 1 / fail — MCP loads the rule instead of "No wiring rules configured"', async () => {
    const root = project({
      'sharkcraft/sharkcraft.config.ts':
        "export default { projectName: 'fx', wiringRules: [{ id: 'w-err', " +
        "declared: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' }, " +
        "registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' } }] };\n",
      'src/h/a.ts': 'export const A_H = 1;\n',
      'src/h/b.ts': 'export const B_H = 2;\n',
      'src/reg.ts': 'export const H = [B_H];\n',
    });
    const { cli, mcp } = await cliAndMcp(root, [...OTHERS, 'knowledge-symbol', 'policy']);
    expect({ code: cli.code, exitCode: cli.exitCode, verdict: cli.verdict }).toEqual({ code: 1, exitCode: 1, verdict: 'fail' });
    expect({ exitCode: mcp.exitCode, verdict: mcp.verdict }).toEqual({ exitCode: cli.exitCode, verdict: cli.verdict });
    expect(mcp.gates.find((g) => g.id === 'wiring')?.status).toBe('fail');
  }, SLOW);
});

describe('a stale code-graph index: `graph status` stale ≡ `shrk gate` NOT VERIFIED ≡ MCP (R11-GAP-2)', () => {
  /** Every gate that does not read the code-graph index. */
  const NON_INDEX = ['impact-baseline', 'structural-patterns', 'intent-classifier', 'wiring', 'policy', 'knowledge-symbol'];

  test('graph-fresh warns with coverage, every index-derived gate is loud-skipped, and the run settles 2 — a reindex clears it', async () => {
    const root = project({ 'src/a.ts': 'export const a = 1;\n' });
    expect((await run({ run: runGraphIndex }, args(root, ['index']))).code).toBe(0);
    // Two new files importing each other, no reindex.
    writeFileSync(join(root, 'src', 'c1.ts'), "import { c2 } from './c2.ts';\nexport const c1 = () => c2;\n");
    writeFileSync(join(root, 'src', 'c2.ts'), "import { c1 } from './c1.ts';\nexport const c2 = () => c1;\n");

    const status = JSON.parse((await run({ run: runGraphStatus }, args(root, ['status'], { json: true }))).out) as {
      state: string;
    };
    expect(status.state).toBe('stale');

    const { cli, mcp } = await cliAndMcp(root, NON_INDEX);
    expect({ code: cli.code, exitCode: cli.exitCode, verdict: cli.verdict }).toEqual({
      code: 2,
      exitCode: 2,
      verdict: 'not-verified',
    });
    expect({ exitCode: mcp.exitCode, verdict: mcp.verdict }).toEqual({ exitCode: cli.exitCode, verdict: cli.verdict });
    const byId = Object.fromEntries(cli.gates.map((g) => [g.id, g]));
    expect(byId['graph-fresh']?.status).toBe('warn');
    expect(byId['graph-fresh']?.message).not.toContain('is fresh');
    for (const id of ['arch', 'impact', 'graph-cycles', 'graph-unresolved']) {
      expect({ id, status: byId[id]?.status, stale: byId[id]?.message.includes('behind the working tree') }).toEqual({
        id,
        status: 'skipped',
        stale: true,
      });
    }

    expect((await run({ run: runGraphIndex }, args(root, ['index']))).code).toBe(0);
    const after = await cliAndMcp(root, NON_INDEX);
    expect(after.cli.gates.find((g) => g.id === 'graph-fresh')?.status).toBe('pass');
    for (const g of after.cli.gates) expect(g.message).not.toContain('behind the working tree');
  }, SLOW);
});

describe('knowledge-symbol gate exit ≡ `knowledge stale-check` exit (R11-COV-4)', () => {
  function knowledge(refs: string): string {
    return project({
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n",
      'sharkcraft/knowledge.ts': `export default [{ id: 'k.one', title: 'One', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About the fixture.', references: ${refs} }];\n`,
      'src/a.ts': 'export const a = 1;\n',
    });
  }

  const CASES: readonly { name: string; refs: string; exit: number }[] = [
    { name: 'only an unpinned symbol (nothing checkable)', refs: "[{ kind: 'symbol', symbol: 'NoSuchSymbolAnywhere' }]", exit: 2 },
    { name: 'a resolving file + an unpinned symbol', refs: "[{ kind: 'file', path: 'src/a.ts' }, { kind: 'symbol', symbol: 'NoSuchSymbolAnywhere' }]", exit: 0 },
    { name: 'a resolving file + a MALFORMED symbol (no `symbol`)', refs: "[{ kind: 'file', path: 'src/a.ts' }, { kind: 'symbol' }]", exit: 2 },
  ];

  for (const c of CASES) {
    test(`${c.name}: stale-check ${c.exit} ≡ shrk gate ≡ MCP get_quality_gate`, async () => {
      const root = knowledge(c.refs);
      const stale = await run(knowledgeStaleCheckCommand, args(root, []));
      const { cli, mcp } = await cliAndMcp(root, [...OTHERS, 'wiring', 'policy']);
      const ksym = cli.gates.find((g) => g.id === 'knowledge-symbol');
      expect({ stale: stale.code, gate: cli.code, gateJson: cli.exitCode, mcp: mcp.exitCode }).toEqual({
        stale: c.exit,
        gate: c.exit,
        gateJson: c.exit,
        mcp: c.exit,
      });
      // "N resolve" counts only CHECKED references — never an unknown or a malformed one.
      expect(ksym?.message).not.toMatch(/^2 symbol\/file reference\(s\) resolve/);
      if (c.exit === 2) expect(ksym?.message).toContain('NOT VERIFIED');
    }, SLOW);
  }
});
