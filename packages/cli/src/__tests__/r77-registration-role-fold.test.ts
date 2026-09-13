/**
 * r77 — P4: the registration-graph absence queries fold THE role authority's
 * coverage (round 13, DECISIONS §5 P4).
 *
 * An idiom whose DECLARED role names a file that does not exist printed
 * `✓ Every declared/injected token has a provider. ✓` at exit 0 on `wiring
 * unprovided`, `✓ … consumed somewhere` on `wiring orphans`, `✓ unprovided
 * pass` on finish and `{verdict:'pass', coverage:null}` on MCP
 * `get_wiring_graph` — while `gates check` said NOT VERIFIED on the same tree.
 * The four read the graph's read scope only; none consulted
 * `measureRegistrationRoles`. Now every surface folds each idiom's role record
 * (`measureIdiomRoleCoverage`), and the CLI verbs' `--json` always carries the
 * gate envelope and the coverage.
 *
 * Real workspaces, the real config loader, the CLI spawned from source and the
 * real MCP tool from ALL_TOOLS.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  measureIdiomRoleCoverage,
  measureRegistrationRoles as boundariesMeasure,
  planeScanExcludeDirs,
} from '@shrkcrft/boundaries';
import { coverageShortfall } from '@shrkcrft/core';
import { inspectSharkcraft, resolveProjectConfig } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import { measureRegistrationRoles as gatesMeasure } from '../gates/measure-registration-roles.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');
const T = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const idioms = (declaredFile: string): string =>
  "registrationGraph: [ { name: 'di', " +
  `declared: { files: ['${declaredFile}'], pattern: 'export const ([A-Z_]+) = new InjectionToken' }, ` +
  "provided: { files: ['src/module.ts'], pattern: 'provide[(]([A-Z_]+)' }, " +
  "consumed: { files: ['src/use.ts'], pattern: 'inject[(]([A-Z_]+)' } } ]";

function workspace(declaredFile: string, extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-role-fold-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', ${idioms(declaredFile)} };\n`,
    'src/module.ts': 'provide(A_TOKEN);\n',
    'src/use.ts': 'inject(A_TOKEN);\n',
    ...extra,
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** The declared role names `src/planned/tokens.ts`, which does not exist; provided and consumed are live. */
const deadDeclared = (): string => workspace('src/planned/tokens.ts');
/** The same idiom with a live declared role. */
const liveDeclared = (): string =>
  workspace('src/tokens.ts', { 'src/tokens.ts': "export const A_TOKEN = new InjectionToken('a');\n" });

function shrk(cwd: string, argv: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--no-hints', ...argv], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function json<T>(cwd: string, argv: readonly string[]): { status: number; body: T } {
  const r = shrk(cwd, argv);
  try {
    return { status: r.status, body: JSON.parse(r.stdout) as T };
  } catch {
    throw new Error(`\`shrk ${argv.join(' ')}\` did not print JSON (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
}

interface IQueryJson {
  readonly exitCode: number;
  readonly verdict: string;
  readonly shortfalls: readonly string[];
  readonly coverage: readonly { unit: string; subject?: string; unexamined?: readonly string[] }[];
  readonly gate: { exit: number; verdict: string; shortfalls: readonly string[]; rules: readonly { id: string; status: string }[] };
}

async function wiringGraph(root: string): Promise<Record<string, unknown>> {
  const tool = ALL_TOOLS.find((t) => t.name === 'get_wiring_graph');
  if (!tool) throw new Error('no get_wiring_graph tool');
  const inspection = await inspectSharkcraft({ cwd: root });
  return (await tool.handler({}, { inspection, cwd: root })).data as Record<string, unknown>;
}

describe('P4 — one role authority, read by the queries too', () => {
  test('the CLI gates path re-exports THE boundaries function (one measurement, not two)', () => {
    expect(gatesMeasure).toBe(boundariesMeasure);
  });

  test('measureIdiomRoleCoverage names the dead declared role, from the loaded config', async () => {
    const root = deadDeclared();
    const loaded = await resolveProjectConfig(root);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const idiomList = loaded.value.config.registrationGraph ?? [];
    const [roles] = measureIdiomRoleCoverage(root, idiomList, planeScanExcludeDirs(root, loaded.value.sharkcraftDir));
    expect(roles?.idiom).toBe('di');
    expect(roles?.readGap).toBe(false);
    expect(roles?.coverage).toMatchObject({ unit: 'roles', expected: 3, examined: 2, unexamined: ['declared (0 files)'] });
    expect(coverageShortfall(roles!.coverage)).toBeDefined();
  });
});

describe('P4 — a dead declared role is NOT VERIFIED on all four surfaces, never ✓', () => {
  test(
    '`wiring unprovided`: 2, the role named, no ✓ — and `--json` carries gate + coverage',
    () => {
      const root = deadDeclared();
      const text = shrk(root, ['wiring', 'unprovided']);
      expect(text.status).toBe(2);
      expect(text.stdout).not.toContain('✓');
      expect(text.stdout).toContain('NOT VERIFIED: di:');
      expect(text.stdout).toContain('declared (0 files)');

      const { status, body } = json<IQueryJson>(root, ['wiring', 'unprovided', '--json']);
      expect(status).toBe(2);
      expect(body.exitCode).toBe(2);
      expect(body.gate.exit).toBe(2);
      expect(body.gate.verdict).toBe('not-verified');
      expect(body.coverage.some((c) => c.subject === 'di' && (c.unexamined ?? []).includes('declared (0 files)'))).toBe(true);
      expect(body.shortfalls.join('\n')).toContain('declared (0 files)');
    },
    T,
  );

  test(
    '`wiring orphans`: 2 as well — "every provider is consumed" over a dead role proves nothing',
    () => {
      const root = deadDeclared();
      const text = shrk(root, ['wiring', 'orphans']);
      expect(text.status).toBe(2);
      expect(text.stdout).not.toContain('✓');
      const { body } = json<IQueryJson>(root, ['wiring', 'orphans', '--json']);
      expect(body.gate.exit).toBe(2);
      expect(body.shortfalls.join('\n')).toContain('declared (0 files)');
    },
    T,
  );

  test(
    "finish: the unprovided sub-gate is partial and the verdict not-verified (it printed `✓ unprovided pass`)",
    () => {
      const root = deadDeclared();
      const { status, body } = json<{
        verdict: string;
        exit: number;
        gates: { name: string; status: string; shortfall?: string }[];
      }>(root, ['finish', '--files', 'src/module.ts', '--json']);
      const gate = body.gates.find((g) => g.name === 'unprovided');
      expect(gate?.status).toBe('partial');
      expect(gate?.shortfall ?? '').toContain('declared (0 files)');
      expect(body.verdict).toBe('not-verified');
      expect(status).toBe(2);
    },
    T,
  );

  test(
    'MCP get_wiring_graph: not-verified with the role in coverage (it said pass with coverage null)',
    async () => {
      const root = deadDeclared();
      const before = readdirSync(root).sort();
      const data = await wiringGraph(root);
      expect(data.verdict).toBe('not-verified');
      expect(String(data.shortfall ?? '')).toContain('declared (0 files)');
      expect(JSON.stringify(data.coverage)).toContain('declared (0 files)');
      // MCP never writes.
      expect(readdirSync(root).sort()).toEqual(before);
    },
    T,
  );
});

/** Two idioms over the same provider / consumer files; each `declared.files` entry is a JS expression. */
function twoIdioms(declaredA: string, declaredB: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-role-fold-two-'));
  roots.push(root);
  const config =
    "registrationGraph: [ { name: 'alpha', " +
    `declared: { files: [${declaredA}], pattern: 'export const ([A-Z_]+) = new InjectionToken' }, ` +
    "provided: { files: ['src/module.ts'], pattern: 'provide[(]([A-Z_]+)' }, " +
    "consumed: { files: ['src/use.ts'], pattern: 'inject[(]([A-Z_]+)' } }, " +
    "{ name: 'beta', " +
    `declared: { files: [${declaredB}], pattern: 'export const ([A-Z_]+) = new Token' }, ` +
    "provided: { files: ['src/module.ts'], pattern: 'bind[(]([A-Z_]+)' }, " +
    "consumed: { files: ['src/use.ts'], pattern: 'get[(]([A-Z_]+)' } } ]";
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', ${config} };\n`,
    'src/module.ts': 'provide(A_TOKEN);\nbind(B_TOKEN);\n',
    'src/use.ts': 'inject(A_TOKEN);\nget(B_TOKEN);\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

interface IFinishJson {
  readonly exit: number;
  readonly verdict: string;
  readonly gates: readonly { name: string; status: string; shortfall?: string }[];
  readonly gate: { exit: number; accepted: readonly string[]; shortfalls: readonly string[] };
}

describe('P4 review — finish carries EVERY idiom’s record, never one', () => {
  test(
    'two idioms with an intended-empty declared role: finish prints BOTH acceptances, as `wiring unprovided` and MCP do (it printed only the first)',
    async () => {
      const root = twoIdioms(
        "{ pattern: 'src/planned/a-tokens.ts', expectEmpty: true }",
        "{ pattern: 'src/planned/b-tokens.ts', expectEmpty: true }",
      );
      const { status, body } = json<IFinishJson>(root, ['finish', '--files', 'src/module.ts', '--json']);
      expect(status).toBe(0);
      const accepted = body.gate.accepted.join('\n');
      expect(accepted).toContain('alpha: accepted by expectEmpty');
      expect(accepted).toContain('beta: accepted by expectEmpty');
      // The same two acceptances on the sibling surfaces.
      const wiring = json<{ accepted: readonly string[] }>(root, ['wiring', 'unprovided', '--json']);
      expect(wiring.body.accepted.length).toBe(2);
      const data = await wiringGraph(root);
      expect((data.accepted as readonly string[]).length).toBe(2);
    },
    T,
  );

  test(
    'two idioms whose declared roles match no file: the unprovided sub-gate is partial and names BOTH',
    () => {
      const root = twoIdioms("'src/planned/a-tokens.ts'", "'src/planned/b-tokens.ts'");
      const { status, body } = json<IFinishJson>(root, ['finish', '--files', 'src/module.ts', '--json']);
      expect(status).toBe(2);
      const gate = body.gates.find((g) => g.name === 'unprovided');
      expect(gate?.status).toBe('partial');
      expect(gate?.shortfall ?? '').toContain('alpha: ');
      expect(gate?.shortfall ?? '').toContain('beta: ');
      const shortfalls = body.gate.shortfalls.join('\n');
      expect(shortfalls).toContain('alpha:');
      expect(shortfalls).toContain('beta:');
    },
    T,
  );
});

describe('P4 control — live roles keep the clean answer', () => {
  test(
    '`wiring unprovided` ✓ at 0, gate.exit 0, the role record full; MCP says pass',
    async () => {
      const root = liveDeclared();
      const text = shrk(root, ['wiring', 'unprovided']);
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('has a provider. ✓');
      const { body } = json<IQueryJson>(root, ['wiring', 'unprovided', '--json']);
      expect(body.gate.exit).toBe(0);
      expect(body.shortfalls).toEqual([]);
      expect(body.coverage.some((c) => c.subject === 'di' && c.unit === 'roles')).toBe(true);
      const data = await wiringGraph(root);
      expect(data.verdict).toBe('pass');
    },
    T,
  );
});
