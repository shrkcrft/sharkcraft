/**
 * r75 — ONE quality authority: `shrk quality`, MCP `get_quality_report` and
 * the dashboard summary can never read `pass` / `warn` where the bundle fails
 * or is not verified (round 11 review R11-COV-2 / MCP-1 / R11-COV-7).
 *
 *   - the knowledge stale-check gate lived only in the CLI bundle, so MCP read
 *     `warn` over a stale corpus `shrk quality` failed. It is now the
 *     inspector's `knowledgeStaleQualityGate` — one row both read;
 *   - the seven data-defined planes run only in `shrk quality`; everywhere
 *     else a config declaring plane rules gets a NOT-RUN `gate-planes` row,
 *     so the report is `not-verified`, never `pass`;
 *   - the packs doctor over ZERO packs was `passed` everywhere but `packs
 *     doctor` itself. `packDoctorVerdict` is the one settlement.
 *
 * Real temp projects, the real config loader / inspector / command handlers
 * and the registered MCP tools.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { GATE_PLANE_CONFIG_KEY, GATE_PLANE_ORDER } from '@shrkcrft/config';
import { declaredGatePlaneRules, inspectSharkcraft, resolveProjectConfig } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import type { ParsedArgs } from '../command-registry.ts';
import { checkCommand } from '../commands/check.command.ts';
import { packsDoctorCommand } from '../commands/packs.command.ts';
import { qualityCommand } from '../commands/quality.command.ts';
import { ExitCode } from '../exit-codes.ts';
import { collectGateRules, GATE_PLANES } from '../gates/gate-rule-view.ts';

const SLOW = 120_000;
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

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
  let err = '';
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    void err;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-qparity-'));
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

/** A_H is declared and never registered: the wiring rule fails. */
const WIRING = {
  'sharkcraft/sharkcraft.config.ts':
    "export default { projectName: 'fx', wiringRules: [{ id: 'w-err', " +
    "declared: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' }, " +
    "registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' } }] };\n",
  'src/h/a.ts': 'export const A_H = 1;\n',
  'src/h/b.ts': 'export const B_H = 2;\n',
  'src/reg.ts': 'export const H = [B_H];\n',
};

function knowledge(refs: string): Record<string, string> {
  return {
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n",
    'sharkcraft/knowledge.ts': `export default [{ id: 'k.one', title: 'One', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'About the fixture.', references: ${refs} }];\n`,
    'src/a.ts': 'export const a = 1;\n',
  };
}

const MINIMAL = {
  'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
  'src/a.ts': 'export const a = 1;\n',
};

interface IQualityJson {
  verdict: string;
  items: { id: string; status: string }[];
}

async function surfaces(root: string): Promise<{ cli: { code: number; verdict: string; items: IQualityJson['items'] }; mcp: { overall: string; gates: { id: string; executed: boolean; data?: Record<string, unknown> }[] }; dashboard: string | undefined }> {
  const cliRun = await run(qualityCommand, args(root, [], { json: true }));
  const cli = JSON.parse(cliRun.out) as IQualityJson;
  const inspection = await inspectSharkcraft({ cwd: root });
  const mcp = (await tool('get_quality_report').handler({}, { inspection, cwd: root })).data as {
    overall: string;
    gates: { id: string; executed: boolean; data?: Record<string, unknown> }[];
  };
  const dash = (await tool('get_dashboard_summary').handler({}, { inspection, cwd: root })).data as {
    quality: { overall: string } | null;
  };
  return { cli: { code: cliRun.code, verdict: cli.verdict, items: cli.items }, mcp, dashboard: dash.quality?.overall };
}

describe('`shrk quality` ≡ MCP get_quality_report ≡ dashboard — never pass / warn over a failing or unrun gate', () => {
  test('a failing wiring rule: quality fails (1); MCP + dashboard are not-verified (planes not run) — never pass', async () => {
    const s = await surfaces(project(WIRING));
    expect({ code: s.cli.code, verdict: s.cli.verdict }).toEqual({ code: ExitCode.Failure, verdict: 'fail' });
    const planes = s.mcp.gates.find((g) => g.id === 'gate-planes');
    expect(planes).toMatchObject({ executed: false, data: { rules: 1 } });
    expect(s.mcp.overall).toBe('not-verified');
    expect(s.dashboard).toBe('not-verified');
  }, SLOW);

  test('a stale knowledge reference: quality fails (1) and so does MCP — the same knowledge-stale gate', async () => {
    const s = await surfaces(project(knowledge("[{ kind: 'file', path: 'packages/gone.ts' }]")));
    expect({ code: s.cli.code, verdict: s.cli.verdict }).toEqual({ code: ExitCode.Failure, verdict: 'fail' });
    expect(s.cli.items.find((i) => i.id === 'knowledge-stale')?.status).toBe('failed');
    expect(s.mcp.gates.some((g) => g.id === 'knowledge-stale')).toBe(true);
    expect(s.mcp.overall).toBe('fail');
    expect(s.dashboard).toBe('fail');
  }, SLOW);

  test('an unverifiable corpus: quality is not verified (2) and so is MCP', async () => {
    const s = await surfaces(project(knowledge("[{ kind: 'symbol', symbol: 'NoSuchSymbolAnywhere' }]")));
    expect({ code: s.cli.code, verdict: s.cli.verdict }).toEqual({ code: ExitCode.NotVerified, verdict: 'not-verified' });
    expect(s.mcp.gates.find((g) => g.id === 'knowledge-stale')?.data?.['partial']).toBe(true);
    expect(s.mcp.overall).toBe('not-verified');
  }, SLOW);

  test('a clean minimal project passes on every surface — and MCP adds no plane row when none is declared', async () => {
    const s = await surfaces(project(MINIMAL));
    expect({ code: s.cli.code, verdict: s.cli.verdict }).toEqual({ code: ExitCode.VerifiedPass, verdict: 'pass' });
    expect(s.mcp.gates.some((g) => g.id === 'gate-planes')).toBe(false);
    expect(s.mcp.overall).toBe('pass');
    expect(s.dashboard).toBe('pass');
  }, SLOW);

  test("the report's plane count is `collectGateRules`' count — here and on this repo's own config", async () => {
    for (const root of [project(WIRING), REPO_ROOT]) {
      const resolved = await resolveProjectConfig(root);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) continue;
      expect((await declaredGatePlaneRules(root)).total).toBe(collectGateRules(resolved.value.config).length);
    }
  }, SLOW);

  test('NO config is not a load error: no `gate-planes` row (finish calls the planes not applicable); a config that FAILED to load keeps its row (R12-REG-2)', async () => {
    // Only package.json + src/: the loader finds no sharkcraft/ folder.
    const bare = project({ 'src/a.ts': 'export const a = 1;\n' });
    expect(await declaredGatePlaneRules(bare)).toEqual({ total: 0, byPlane: {} });
    const bareInspection = await inspectSharkcraft({ cwd: bare });
    const bareReport = (await tool('get_quality_report').handler({}, { inspection: bareInspection, cwd: bare })).data as {
      gates: { id: string }[];
    };
    expect(bareReport.gates.some((g) => g.id === 'gate-planes')).toBe(false);

    // A config that exists but is rejected (an unrecognized key): nothing can be
    // said about what it declares, so the not-run row stays.
    const broken = project({
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', notARealKey: 1 };\n",
      'src/a.ts': 'export const a = 1;\n',
    });
    const brokenPlanes = await declaredGatePlaneRules(broken);
    expect(brokenPlanes.loadError).toBeDefined();
    const brokenInspection = await inspectSharkcraft({ cwd: broken });
    const brokenReport = (await tool('get_quality_report').handler({}, { inspection: brokenInspection, cwd: broken })).data as {
      gates: { id: string; executed: boolean }[];
    };
    expect(brokenReport.gates.find((g) => g.id === 'gate-planes')).toMatchObject({ executed: false });
  }, SLOW);
});

describe('ONE plane → config-key list, beside the config schema (R12-AUTH-1)', () => {
  test('`GATE_PLANES` is the config list, and no other source spells the plane → key map', () => {
    expect([...GATE_PLANES] as string[]).toEqual(Object.keys(GATE_PLANE_CONFIG_KEY));
    expect([...GATE_PLANES]).toEqual([...GATE_PLANE_ORDER]);
    // A plane → key pair written out anywhere else is a second copy of the list.
    const pair = /['"]doc-reference['"]\s*[:,]\s*['"]docReferences['"]/;
    const owner = join('packages', 'config', 'src', 'gate-plane-config-keys.ts');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts') && pair.test(readFileSync(p, 'utf8'))) offenders.push(relative(REPO_ROOT, p));
      }
    };
    walk(join(REPO_ROOT, 'packages'));
    expect(offenders).toEqual([owner]);
  });
});

describe('the packs doctor over ZERO packs is never "passed" (R11-COV-7)', () => {
  test('packs doctor ≡ MCP doctor_packs (not-verified, 2); the quality item and bare `check` skip it', async () => {
    const root = project(MINIMAL);
    const verb = await run(packsDoctorCommand, args(root, [], { json: true }));
    const verbJson = JSON.parse(verb.out) as { exitCode: number; verdict: string; passed: boolean };
    expect({ code: verb.code, exitCode: verbJson.exitCode, verdict: verbJson.verdict, passed: verbJson.passed }).toEqual({
      code: 2,
      exitCode: 2,
      verdict: 'not-verified',
      passed: false,
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    const mcp = (await tool('doctor_packs').handler({}, { inspection, cwd: root })).data as {
      exitCode: number;
      verdict: string;
      passed: boolean;
    };
    expect({ exitCode: mcp.exitCode, verdict: mcp.verdict, passed: mcp.passed }).toEqual({
      exitCode: verbJson.exitCode,
      verdict: verbJson.verdict,
      passed: verbJson.passed,
    });

    const quality = JSON.parse((await run(qualityCommand, args(root, [], { json: true }))).out) as IQualityJson;
    expect(quality.items.find((i) => i.id === 'packs')?.status).toBe('skipped');
    const report = (await tool('get_quality_report').handler({}, { inspection, cwd: root })).data as {
      gates: { id: string; data?: Record<string, unknown> }[];
    };
    expect(report.gates.find((g) => g.id === 'packs')?.data?.['examinedNothing']).toBe(true);

    const check = JSON.parse((await run(checkCommand, args(root, [], { json: true }))).out) as {
      groups: { name: string; status: string }[];
    };
    expect(check.groups.find((g) => g.name === 'packs')?.status).toBe('skipped');
  }, SLOW);
});
