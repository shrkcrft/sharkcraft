/**
 * Round 11 — `check boundaries` can no longer pass over something it did not
 * check.
 *
 *   1.3                 a rule whose scope matched nothing is never "evaluated";
 *   1.3#invalid-rule    a dropped rule is an ERRORED rule, exit 1;
 *   3.3#2 --rule-file   evaluate a candidate rule file directly;
 *   3.3#3 --diff-against  what a candidate set would add / remove;
 *   6.3 / closing#d     a rule edit escalates `--changed-only` (never "legacy");
 *   5.2                 an unknown flag is a usage error, never a silent true.
 *
 * Every fixture is a mkdtemp workspace with a REAL sharkcraft/boundaries.ts
 * listed in a real config, run through the real command handler.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-bnd-'));
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

function verdictLines(out: string): string[] {
  return out.split('\n').filter((l) => l.startsWith('Verdict:'));
}

function git(root: string, ...a: string[]): void {
  spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', '-c', 'commit.gpgsign=false', ...a], { cwd: root });
}

describe('1.3 — a rule that checked nothing is never evaluated', () => {
  test('a dead-scope ERROR rule exits 1 (failOnEmpty by default), text and JSON alike', async () => {
    const root = project(
      rulesOf("{ id: 'old.dead', title: 'Old', severity: 'error', from: ['packages/old/**'], forbiddenImports: ['@scope/ui'] }"),
      { 'src/app/a.ts': 'export const a = 1;\n' },
    );
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain('old.dead checked nothing');
    expect(verdictLines(text.out).join(' ')).not.toContain('OK');
    const json = await run(checkCommand, args(root, ['boundaries'], { json: true }));
    const p = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.Failure);
    expect(p.gate.exit).toBe(json.code);
    // Round 11 review: a failOnEmpty skip is `failed` in the envelope (the
    // wiring plane's mapping), so gate.failed counts the rule that failed the
    // run; it still never counts as evaluated in `rulesEvaluated`.
    expect(p.gate).toMatchObject({ failed: 1, skipped: 0 });
    expect(p.gate.rules).toEqual([expect.objectContaining({ id: 'old.dead', status: 'failed' })]);
    expect(p.gate.rules[0].skipReason).toContain('packages/old/**');
    expect(p.rulesEvaluated).toBe(0);
    expect(p.skipped).toEqual([expect.objectContaining({ ruleId: 'old.dead', failed: true })]);
  });

  test('a dead-scope WARNING rule next to a live one exits 2 — NOT VERIFIED, never OK', async () => {
    const root = project(
      rulesOf(
        APP_NO_UI,
        "{ id: 'old.dead', title: 'Old', severity: 'warning', from: ['packages/old/**'], forbiddenImports: ['@scope/ui'] }",
      ),
      { 'src/app/a.ts': 'export const a = 1;\n' },
    );
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    expect(verdictLines(text.out).join(' ')).not.toContain('OK');
    expect(text.out).not.toMatch(/\.\s*✓/);
    const json = await run(checkCommand, args(root, ['boundaries'], { json: true }));
    const p = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.NotVerified);
    expect(p.gate).toMatchObject({ exit: 2, evaluated: 1, skipped: 1, verdict: 'not-verified' });
    expect(p.verdict).toBe('not-verified');
  });

  test('an unknown --rule exits 3 and lists the configured ids', async () => {
    const root = project(rulesOf(APP_NO_UI), { 'src/app/a.ts': 'export const a = 1;\n' });
    const text = await run(checkCommand, args(root, ['boundaries'], { rule: 'no.such.rule' }));
    expect(text.code).toBe(ExitCode.UsageError);
    expect(text.err).toContain('no.such.rule');
    expect(text.err).toContain('app.no-ui');
    const json = await run(checkCommand, args(root, ['boundaries'], { rule: 'no.such.rule', json: true }));
    const p = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.UsageError);
    expect(p.gate.exit).toBe(ExitCode.UsageError);
    expect(p.available).toEqual(['app.no-ui']);
  });

  test('a clean, fully-examined run is an earned 0 whose gate exit matches', async () => {
    const root = project(rulesOf(APP_NO_UI), { 'src/app/a.ts': "import { x } from '@scope/data';\n" });
    const json = await run(checkCommand, args(root, ['boundaries'], { json: true }));
    const p = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.VerifiedPass);
    expect(p.gate).toMatchObject({ exit: 0, evaluated: 1, skipped: 0 });
    expect(p.coverage[0]).toMatchObject({ ruleId: 'app.no-ui', status: 'passed', filesInScope: 1 });
  });
});

describe('1.3#boundary-invalid-rule — a dropped rule is an errored rule, never a silent green', () => {
  test('a rule missing its title exits 1, names the file and the rule, and is never evaluated', async () => {
    const root = project(rulesOf("{ id: 'src.no-lodash', from: ['src/**'], forbiddenImports: ['lodash'] }"), {
      'src/a.ts': "import _ from 'lodash';\n",
    });
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain("sharkcraft/boundaries.ts: rule 'src.no-lodash' failed validation — NOT evaluated");
    expect(text.out).toContain('title: title required');
    const json = await run(checkCommand, args(root, ['boundaries'], { json: true }));
    const p = JSON.parse(json.out);
    expect(p.loadIssues).toEqual([expect.objectContaining({ kind: 'invalid-rule', ruleId: 'src.no-lodash', file: 'sharkcraft/boundaries.ts' })]);
    expect(p.gate.rules).toContainEqual(expect.objectContaining({ id: 'src.no-lodash', status: 'error' }));
    expect(p.gate.evaluated).toBe(0);
    expect(p.rulesEvaluated).toBe(0);
  });

  test('a boundary file that throws on import exits 1 with the loader error', async () => {
    const root = project("throw new Error('boom from the rules file');\nexport default [];\n", {
      'src/a.ts': 'export const a = 1;\n',
    });
    const text = await run(checkCommand, args(root, ['boundaries']));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain('rule file failed to load');
    expect(text.out).toContain('boom from the rules file');
  });
});

describe('3.3#2 — --rule-file evaluates a candidate rule file directly (and flags are checked)', () => {
  const FILES = {
    'src/app/a.ts': "import { u } from '@scope/ui';\nimport { d } from '@scope/data';\n",
    'candidate.ts': rulesOf("{ id: 'cand.no-data', title: 'No data', severity: 'error', from: ['src/**'], forbiddenImports: ['@scope/data'] }"),
    'invalid-candidate.ts': rulesOf("{ id: 'cand.bad', from: ['src/**'], forbiddenImports: ['x'] }"),
  };

  test("only the candidate's rules run — the configured rules are absent from the report", async () => {
    const root = project(rulesOf(APP_NO_UI), FILES);
    const json = await run(checkCommand, args(root, ['boundaries'], { 'rule-file': 'candidate.ts', json: true }));
    const p = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.Failure);
    expect(p.ruleSource).toMatchObject({ kind: 'rule-file' });
    expect([...new Set(p.violations.map((v: { ruleId: string }) => v.ruleId))]).toEqual(['cand.no-data']);
  });

  test('a missing --rule-file exits 3', async () => {
    const root = project(rulesOf(APP_NO_UI), FILES);
    const r = await run(checkCommand, args(root, ['boundaries'], { 'rule-file': 'nope.ts' }));
    expect(r.code).toBe(ExitCode.UsageError);
    expect(r.err).toContain('does not exist');
  });

  test('a --rule-file whose only rule is invalid exits 3 and names the validation issue', async () => {
    const root = project(rulesOf(APP_NO_UI), FILES);
    const r = await run(checkCommand, args(root, ['boundaries'], { 'rule-file': 'invalid-candidate.ts' }));
    expect(r.code).toBe(ExitCode.UsageError);
    expect(r.err).toContain('defines no valid boundary rule');
    expect(r.err).toContain('title');
  });

  test('an unknown flag is rejected with exit 3 (never swallowed as a silent true)', async () => {
    const root = project(rulesOf(APP_NO_UI), FILES);
    const r = await run(checkCommand, args(root, ['boundaries'], { rules: 'candidate.ts' }));
    expect(r.code).toBe(ExitCode.UsageError);
    expect(r.err).toContain('--rules is not a flag of this command');
  });
});

describe('3.3#3 — --diff-against: the added / removed violations of a candidate rule set', () => {
  const FILES = {
    'src/app/a.ts': "import { u } from '@scope/ui';\nimport { d } from '@scope/data';\n",
    'src/app/b.ts': "import { d } from '@scope/data';\n",
    'tighter.ts': rulesOf("{ id: 'app.no-ui', title: 'App no UI', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/ui', '@scope/data'] }"),
    'looser.ts': rulesOf("{ id: 'app.no-ui', title: 'App no UI', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/other'] }"),
    'renamed.ts': rulesOf("{ id: 'app.no-ui-v2', title: 'App no UI', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/ui'] }"),
  };
  const diffOf = async (root: string, file: string) => {
    const r = await run(checkCommand, args(root, ['boundaries'], { 'diff-against': file, json: true }));
    return { code: r.code, diff: JSON.parse(r.out) };
  };

  test('a same-id tightening reports exactly the new edges as added, and exits 1', async () => {
    const root = project(rulesOf(APP_NO_UI), FILES);
    const { code, diff } = await diffOf(root, 'tighter.ts');
    expect(code).toBe(ExitCode.Failure);
    expect(diff.rulesReplaced).toEqual(['app.no-ui']);
    expect(diff.added.map((v: { file: string; importSpecifier: string }) => `${v.file}→${v.importSpecifier}`).sort()).toEqual([
      'src/app/a.ts→@scope/data',
      'src/app/b.ts→@scope/data',
    ]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toBe(1);
    expect(diff.gate.exit).toBe(code);
  });

  test('a loosening reports the removed edges and exits 0', async () => {
    const root = project(rulesOf(APP_NO_UI), FILES);
    const { code, diff } = await diffOf(root, 'looser.ts');
    expect(code).toBe(ExitCode.VerifiedPass);
    expect(diff.removed.map((v: { importSpecifier: string }) => v.importSpecifier)).toEqual(['@scope/ui']);
    expect(diff.added).toEqual([]);
  });

  test('a renamed rule shows no edge-level change', async () => {
    const root = project(rulesOf(APP_NO_UI), FILES);
    const { diff } = await diffOf(root, 'renamed.ts');
    expect(diff.rulesAdded).toEqual(['app.no-ui-v2']);
    expect(diff.edgeLevel).toEqual({ newlyFlagged: [], noLongerFlagged: [] });
  });

  test('added + unchanged and removed + unchanged equal the two independent full runs', async () => {
    const root = project(rulesOf(APP_NO_UI), FILES);
    const { diff } = await diffOf(root, 'tighter.ts');
    const active = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out);
    const candidate = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { 'rule-file': 'tighter.ts', json: true }))).out);
    expect(diff.removed.length + diff.unchanged).toBe(active.violations.length);
    expect(diff.added.length + diff.unchanged).toBe(candidate.violations.length);
  });
});

describe('dead units and the comment-aware scanner at the CLI', () => {
  test('--fail-on-dead-units turns a dead unit into exit 1; without the flag the exit is unchanged', async () => {
    const root = project(
      rulesOf("{ id: 'app.typo', title: 'Typo', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/retierd-pkg'] }"),
      { 'src/app/a.ts': "import { u } from '@scope/ui';\n" },
    );
    const plain = await run(checkCommand, args(root, ['boundaries']));
    expect(plain.code).toBe(ExitCode.VerifiedPass);
    expect(plain.out).toContain('Dead selector units (1)');
    const strict = await run(checkCommand, args(root, ['boundaries'], { 'fail-on-dead-units': true }));
    expect(strict.code).toBe(ExitCode.Failure);
  });

  test('a commented-out import is not a violation; --include-comments restores the raw reading', async () => {
    const root = project(rulesOf(APP_NO_UI), {
      'src/app/a.ts': "// import { B } from '@scope/ui';\nexport const a = 1;\n",
    });
    expect((await run(checkCommand, args(root, ['boundaries']))).code).toBe(ExitCode.VerifiedPass);
    expect((await run(checkCommand, args(root, ['boundaries'], { 'include-comments': true }))).code).toBe(ExitCode.Failure);
  });
});

describe('6.3 / closing#d — a rule edit is never filed as "legacy"', () => {
  /** Committed clean; then the rule is tightened without touching any source file. */
  function tightenedRepo(): string {
    const root = project(rulesOf(APP_NO_UI), {
      '.gitignore': '.sharkcraft/\n',
      'src/app/a.ts': "import { d } from '@scope/data';\nexport const a = d;\n",
    });
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'clean');
    writeFileSync(
      join(root, 'sharkcraft', 'boundaries.ts'),
      rulesOf("{ id: 'app.no-ui', title: 'App no UI', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/ui', '@scope/data'] }"),
    );
    return root;
  }

  test('check boundaries --files <the rule file> exits 1 with the new violation, and says it escalated', async () => {
    const root = tightenedRepo();
    const text = await run(checkCommand, args(root, ['boundaries'], { files: 'sharkcraft/boundaries.ts' }));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain('escalated');
    expect(text.out).toContain('src/app/a.ts:1');
    const json = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { files: 'sharkcraft/boundaries.ts', json: true }))).out);
    expect(json.changedScope.escalation.ruleIds).toEqual(['app.no-ui']);
    expect(json.changedScope.ignoredLegacyCount).toBe(0);
  });

  test('--changed-only over the worktree sees the rule edit too', async () => {
    const root = tightenedRepo();
    expect((await run(checkCommand, args(root, ['boundaries'], { 'changed-only': true }))).code).toBe(ExitCode.Failure);
  });

  test('--no-rule-escalation exits 2: changed-only cannot see a rule edit, and says so', async () => {
    const root = tightenedRepo();
    const text = await run(checkCommand, args(root, ['boundaries'], { files: 'sharkcraft/boundaries.ts', 'no-rule-escalation': true }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('--no-rule-escalation');
  });

  test('finish --files <the rule file> reports the boundaries gate FAIL', async () => {
    const root = tightenedRepo();
    const json = await run(finishCommand, args(root, [], { files: 'sharkcraft/boundaries.ts', json: true }));
    const report = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.Failure);
    expect(report.gates.find((g: { name: string }) => g.name === 'boundaries')?.status).toBe('fail');
    expect(report.gate.exit).toBe(json.code);
  });
});
