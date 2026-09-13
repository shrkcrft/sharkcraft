/**
 * Round 11 review fixes — the boundary lane.
 *
 *   #1   an import AFTER a regex literal holding a backtick or `/*` is read:
 *        `check boundaries` (text + JSON), MCP `check_boundaries` and `finish`
 *        all reported a clean pass over the forbidden import;
 *   #2   a failOnEmpty skip is `failed` in the gate envelope (gate.failed
 *        counts it — the wiring plane's mapping), never `skipped` next to an
 *        exit 1; `rulesEvaluated` still never counts it;
 *   #3   overlapping exceptions are all credited — no false stale-exception;
 *   low  the exit-0 verdict line names dead selector units / warnings (no ✓),
 *        and the configuration diagnostics never say a listed file that threw
 *        (or whose every rule was invalid) "loaded".
 *
 * Every fixture is a mkdtemp workspace with a REAL sharkcraft/boundaries.ts
 * listed in a real config, run through the real command handlers and the real
 * registered MCP handler.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import { checkCommand } from '../commands/check.command.ts';
import { finishCommand } from '../commands/finish.command.ts';
import { ExitCode } from '../exit-codes.ts';
import type { ParsedArgs } from '../command-registry.ts';

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
): Promise<{ code: number; out: string; err: string }> {
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
    return { code: await h.run(a), out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A project whose sharkcraft/boundaries.ts holds `rules` (an `export default [...]` body). */
function project(rules: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-bnd-review-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'sharkcraft/boundaries.ts': rules,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const rulesOf = (...rules: string[]): string => `export default [\n${rules.map((r) => `  ${r},`).join('\n')}\n];\n`;
const APP_NO_UI = "{ id: 'app.no-ui', title: 'App no UI', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/ui'] }";

const verdictLines = (out: string): string[] => out.split('\n').filter((l) => l.startsWith('Verdict:'));

const tool = (name: string) => {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
};

type Row = { id: string; status: string; skipReason?: string };

describe('#1 — an import after a regex literal is never hidden from the gate', () => {
  const RULE =
    "{ id: 'app.no-forbidden', title: 'No forbidden', severity: 'error', from: ['packages/app/**'], forbiddenImports: ['@scope/forbidden'] }";
  const FILES = {
    'packages/app/esc.ts':
      "export function esc(s: string): string { return s.replace(/`/g, ''); }\nexport async function load() { return import('@scope/forbidden'); }\n",
    'packages/app/trim.ts':
      "export const trim = (s: string): string => s.replace(/\\/*$/, '');\nexport const lazy = () => require('@scope/forbidden/lazy');\n/** trailing doc */\n",
  };
  const EXPECTED = ['packages/app/esc.ts:2 @scope/forbidden', 'packages/app/trim.ts:2 @scope/forbidden/lazy'];

  test('check boundaries (text + JSON), MCP check_boundaries and finish all FAIL on both edges', async () => {
    const root = project(rulesOf(RULE), FILES);
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain('packages/app/esc.ts:2');
    expect(text.out).toContain('packages/app/trim.ts:2');
    expect(text.out).not.toContain('✓');

    const json = await run(checkCommand, args(root, ['boundaries'], { json: true }));
    const p = JSON.parse(json.out) as {
      exitCode: number;
      gate: { exit: number };
      violations: { file: string; line: number; importSpecifier: string }[];
    };
    expect(json.code).toBe(ExitCode.Failure);
    expect(p.gate.exit).toBe(ExitCode.Failure);
    expect(p.violations.map((v) => `${v.file}:${v.line} ${v.importSpecifier}`).sort()).toEqual(EXPECTED);

    const inspection = await inspectSharkcraft({ cwd: root });
    const mcp = (await tool('check_boundaries').handler({}, { inspection, cwd: root })).data as {
      verdict: string;
      exitCode: number;
      violations: { file: string; line: number; importSpecifier: string }[];
    };
    expect({ verdict: mcp.verdict, exitCode: mcp.exitCode }).toEqual({ verdict: 'fail', exitCode: ExitCode.Failure });
    expect(mcp.violations.map((v) => `${v.file}:${v.line} ${v.importSpecifier}`).sort()).toEqual(EXPECTED);

    const fin = await run(
      finishCommand,
      args(root, [], { files: 'packages/app/esc.ts,packages/app/trim.ts', json: true }),
    );
    const report = JSON.parse(fin.out) as { gates: { name: string; status: string }[] };
    expect(fin.code).toBe(ExitCode.Failure);
    expect(report.gates.find((g) => g.name === 'boundaries')?.status).toBe('fail');
  });
});

describe('#2 — a failOnEmpty skip is `failed` in the gate envelope, as in the wiring plane', () => {
  const DEAD_ERROR =
    "{ id: 'old.dead-scope', title: 'Old', severity: 'error', from: ['packages/old/**'], forbiddenImports: ['@scope/ui'] }";

  test('gate.failed counts it, the docs jq FAIL loop names it, rulesEvaluated (CLI + MCP) stays 0', async () => {
    const root = project(rulesOf(DEAD_ERROR, APP_NO_UI), { 'src/app/a.ts': 'export const a = 1;\n' });
    const json = await run(checkCommand, args(root, ['boundaries'], { rule: 'old.dead-scope', json: true }));
    const p = JSON.parse(json.out) as {
      exitCode: number;
      verdict: string;
      rulesEvaluated: number;
      skipped: { ruleId: string; failed: boolean }[];
      gate: { exit: number; failed: number; skipped: number; rules: Row[] };
    };
    expect(json.code).toBe(ExitCode.Failure);
    expect(p).toMatchObject({ exitCode: 1, verdict: 'errors' });
    expect(p.gate).toMatchObject({ exit: 1, failed: 1, skipped: 0 });
    // docs/gate-json.md: `select(.status=="failed" or .status=="error")` prints the rule that failed the run.
    expect(p.gate.rules.filter((r) => r.status === 'failed' || r.status === 'error').map((r) => r.id)).toEqual([
      'old.dead-scope',
    ]);
    expect(p.gate.rules[0]!.skipReason).toContain('packages/old/**');
    expect(p.rulesEvaluated).toBe(0);
    expect(p.skipped).toEqual([expect.objectContaining({ ruleId: 'old.dead-scope', failed: true })]);

    const inspection = await inspectSharkcraft({ cwd: root });
    const mcp = (await tool('check_boundaries').handler({ ruleId: 'old.dead-scope' }, { inspection, cwd: root })).data as {
      verdict: string;
      exitCode: number;
      rulesEvaluated: number;
      skipped: { ruleId: string; failed: boolean }[];
    };
    expect(mcp).toMatchObject({ verdict: 'fail', exitCode: 1, rulesEvaluated: 0 });
    expect(mcp.skipped).toEqual([expect.objectContaining({ ruleId: 'old.dead-scope', failed: true })]);

    // Text still says it checked nothing, and why it failed.
    const text = await run(checkCommand, args(root, ['boundaries'], { rule: 'old.dead-scope' }));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain('old.dead-scope checked nothing');
    expect(text.out).toContain('1 rule(s) matched nothing (failOnEmpty)');
  });

  test('a WARNING-severity dead rule (no failOnEmpty) stays `skipped` — exit 2, never `failed`', async () => {
    const root = project(
      rulesOf("{ id: 'old.dead-warn', title: 'Old', severity: 'warning', from: ['packages/old/**'], forbiddenImports: ['@scope/ui'] }"),
      { 'src/app/a.ts': 'export const a = 1;\n' },
    );
    const json = await run(checkCommand, args(root, ['boundaries'], { json: true }));
    const p = JSON.parse(json.out) as { gate: { exit: number; failed: number; skipped: number; rules: Row[] } };
    expect(json.code).toBe(ExitCode.NotVerified);
    expect(p.gate).toMatchObject({ exit: 2, failed: 0, skipped: 1 });
    expect(p.gate.rules.map((r) => [r.id, r.status])).toEqual([['old.dead-warn', 'skipped']]);
  });

  test('--diff-against: a dead-scope ERROR candidate is `failed` and exits 1 (it would fail the gate)', async () => {
    const root = project(rulesOf(APP_NO_UI), {
      'src/app/a.ts': "import { u } from '@scope/ui';\n",
      'dead-candidate.ts': rulesOf(
        "{ id: 'cand.dead', title: 'Dead', severity: 'error', from: ['packages/gone/**'], forbiddenImports: ['@scope/ui'] }",
      ),
    });
    const json = await run(checkCommand, args(root, ['boundaries'], { 'diff-against': 'dead-candidate.ts', json: true }));
    const diff = JSON.parse(json.out) as { gate: { exit: number; failed: number; rules: Row[] } };
    expect(json.code).toBe(ExitCode.Failure);
    expect(diff.gate).toMatchObject({ exit: 1, failed: 1 });
    expect(diff.gate.rules.find((r) => r.id === 'cand.dead')?.status).toBe('failed');
    const text = await run(checkCommand, args(root, ['boundaries'], { 'diff-against': 'dead-candidate.ts' }));
    expect(text.code).toBe(ExitCode.Failure);
    expect(verdictLines(text.out).join(' ')).toContain('failOnEmpty');
  });
});

describe('#3 — an exception shadowed by an earlier matching one is credited, never stale', () => {
  test('area-wide + file-level exceptions for the same edge: exit 0, no stale exception, both credited', async () => {
    const root = project(
      rulesOf(
        "{ id: 'app.no-ui', title: 'App no UI', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/ui'], exceptions: [{ path: 'src/app/**', target: '@scope/ui', reason: 'area-wide migration' }, { path: 'src/app/legacy.ts', target: '@scope/ui', reason: 'legacy file' }] }",
      ),
      { 'src/app/legacy.ts': "import { B } from '@scope/ui';\nexport const b = B;\n" },
    );
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).not.toContain('stale exception');
    const json = await run(checkCommand, args(root, ['boundaries'], { json: true }));
    const p = JSON.parse(json.out) as {
      staleExceptions: unknown[];
      suppressedCounts: { exemptFile: number; exception: number };
      coverage: { exceptions: { reason: string; matched: number }[] }[];
    };
    expect(json.code).toBe(ExitCode.VerifiedPass);
    expect(p.staleExceptions).toEqual([]);
    expect(p.suppressedCounts).toEqual({ exemptFile: 0, exception: 1 });
    expect(p.coverage[0]!.exceptions.map((e) => [e.reason, e.matched])).toEqual([
      ['area-wide migration', 1],
      ['legacy file', 1],
    ]);
  });
});

describe('low — the exit-0 verdict line never puts a ✓ next to something reported above', () => {
  test('a dead selector unit is named on the verdict line', async () => {
    const root = project(
      rulesOf("{ id: 'app.typo', title: 'Typo', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/retierd-pkg'] }"),
      { 'src/app/a.ts': "import { u } from '@scope/ui';\n" },
    );
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(verdictLines(text.out)).toEqual([
      'Verdict: no boundary violations — 1 dead selector unit(s) reported above (--fail-on-dead-units to fail on dead units).',
    ]);
    expect(text.out).not.toContain('✓');
  });

  test('a warning violation is named on the verdict line', async () => {
    const root = project(
      rulesOf("{ id: 'app.warn-ui', title: 'Warn UI', severity: 'warning', from: ['src/app/**'], forbiddenImports: ['@scope/ui'] }"),
      { 'src/app/a.ts': "import { u } from '@scope/ui';\n" },
    );
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(verdictLines(text.out)).toEqual(['Verdict: no blocking boundary violations — 1 warning(s) reported above.']);
    expect(text.out).not.toContain('✓');
  });

  test('a run with nothing reported keeps the ✓ sentence', async () => {
    // `@scope/ui` is imported OUTSIDE the rule's scope, so the pattern is live
    // (not a dead unit) and nothing in scope violates it.
    const root = project(rulesOf(APP_NO_UI), {
      'src/app/a.ts': 'export const a = 1;\n',
      'src/lib/b.ts': "import { u } from '@scope/ui';\n",
    });
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(verdictLines(text.out)).toEqual(['Verdict: OK — no boundary violations. ✓']);
  });
});

describe('low — configuration diagnostics never call a file that failed "loaded"', () => {
  test('a listed rule file that throws', async () => {
    const root = project("throw new Error('boom from the rules file');\nexport default [];\n", {
      'src/a.ts': 'export const a = 1;\n',
    });
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain('rule file failed to load');
    expect(text.out).not.toContain('loaded, but define no rules');
  });

  test('a listed rule file whose only rule failed validation', async () => {
    const root = project(rulesOf("{ id: 'src.no-lodash', from: ['src/**'], forbiddenImports: ['lodash'] }"), {
      'src/a.ts': "import _ from 'lodash';\n",
    });
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain("rule 'src.no-lodash' failed validation — NOT evaluated");
    expect(text.out).not.toContain('loaded, but define no rules');
  });
});
