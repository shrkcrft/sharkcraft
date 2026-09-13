/**
 * Round 11 stage 0 — the keystone coverage contract's review defects, each
 * locked at the surface a consumer reads (exit code, --json, the printed line).
 *
 *   #1 `check orphans` — a deleted SOURCE file the index does not know is
 *      expected-but-unexamined, never read clean.
 *   #3 explain surfaces — status / verdict settled by the same core rule as
 *      the envelope; `check wiring --explain` returns the settled exit.
 *   #4 `--allow-empty` on an EMPTY changeset — reachable, and `accepted` only
 *      ever sits next to a 0.
 *   #5 the plane `verdict` of `check wiring` / `policy-lint` --json derives
 *      from the settled exit.
 *   #6 finish's wiring sub-gate — a partial rule settles the composite to 2.
 *   #7 `check wiring --fix` — settled like the check; never 0 over a partial rule.
 *   #8 the verdict-verb registry — `docs references check` is a verdict verb,
 *      its `list` / `explain` siblings are not.
 *   #11 finish — a SELECTED wiring/policy rule that examined nothing settles
 *      its sub-gate `partial` (2) or `fail` (1), never "Safe to finish"; a
 *      change that put no content in a policy rule's scope is narrowing.
 *   #12 `shrk gate` — its wiring and policy gates carry the same coverage.
 *   #13 `impact --deleted` — settles on the orphan coverage authority.
 *
 * (#2 and #9 are locked by the behavioural matrix in
 * r75-verdict-coverage-contract.test.ts.)
 *
 * Fixtures are real workspaces through the real config loader, the real wiring
 * engine and a real code-graph index — never a hand-built inspection.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildFullIndex } from '@shrkcrft/graph';
import { checkCommand } from '../commands/check.command.ts';
import { finishCommand } from '../commands/finish.command.ts';
import { gateCommand } from '../commands/gate.command.ts';
import { impactCommand } from '../commands/impact.command.ts';
import { gatesCheckCommand, gatesExplainCommand } from '../commands/gates.command.ts';
import { policyLintCommand } from '../commands/policy-lint.command.ts';
import { wiringCommand } from '../commands/wiring.command.ts';
import { runFinishGates } from '../finish/run-finish.ts';
import { ExitCode, GATE_VERB_PATHS, isGateVerb, VERDICT_PATH_TOKENS } from '../exit-codes.ts';
import { extractCommandPath } from '../usage/usage-log.ts';
import type { ParsedArgs } from '../command-registry.ts';

const CLI_MAIN = join(import.meta.dir, '..', 'main.ts');
const SLOW = 90_000;

// ── harness ────────────────────────────────────────────────────────────────

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

interface IRun {
  readonly code: number;
  readonly out: string;
}

async function run(h: { run(a: ParsedArgs): Promise<number> | number }, a: ParsedArgs): Promise<IRun> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = '';
  const sink = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    const code = await h.run(a);
    return { code, out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(planes: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-s0-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  writeFileSync(
    join(root, 'sharkcraft', 'sharkcraft.config.ts'),
    `export default { projectName: 'fx'${planes ? `, ${planes}` : ''} };\n`,
  );
  return root;
}

function git(root: string, ...a: string[]): void {
  const res = spawnSync('git', ['-c', 'user.email=r75@test', '-c', 'user.name=r75', '-c', 'commit.gpgsign=false', ...a], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${res.stderr ?? ''}`);
}

function commitAll(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

/** declared {A_H, B_H} ⊂ registered {A_H, B_H, C_H}: C_H has no declared site. */
const SUBSET_FILES: Record<string, string> = {
  'src/h/a.ts': 'export const A_H = 1;\n',
  'src/h/b.ts': 'export const B_H = 2;\n',
  'src/reg.ts': 'export const H = [A_H, B_H, C_H];\n',
};

function subsetRule(extra = ''): string {
  return (
    "wiringRules: [{ id: 'subset-rule', " +
    "declared: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' }, " +
    "registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' }" +
    `${extra} }]`
  );
}

function notVerifiedLine(out: string): string {
  return out.split('\n').find((l) => l.startsWith('NOT VERIFIED:')) ?? '';
}

// ── #3 explain ──────────────────────────────────────────────────────────────

describe('#3 explain settles the rule exactly like the envelope does', () => {
  test('gates explain on a partial subset rule: status partial, verdict not-verified, the shortfall on the line', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    const text = await run(gatesExplainCommand, args(root, ['subset-rule']));
    expect(text.out).toMatch(/^ +status +partial$/m);
    expect(text.out).toMatch(/^ +coverage +examined 2 of 3 registered tokens$/m);
    expect(text.out).toContain('Verdict: not-verified');
    expect(notVerifiedLine(text.out)).toContain('C_H');
    // The extracted set is still printed exactly as before (the do-not-regress lock).
    expect(text.out).toMatch(/^ +declared +2 distinct across 2 file\(s\)/m);
    expect(text.out).toMatch(/^ +registered +3 distinct across 1 file\(s\)/m);

    const json = JSON.parse((await run(gatesExplainCommand, args(root, ['subset-rule'], { json: true }))).out);
    expect(json).toMatchObject({ status: 'partial', verdict: 'not-verified' });
    expect(json.coverage.unexamined).toEqual(['C_H']);
    expect(json.shortfall).toContain('C_H');

    // ONE derivation: `gates check` reports the SAME status for the same rule.
    const gate = JSON.parse((await run(gatesCheckCommand, args(root, [], { json: true }))).out).gate;
    expect(gate.rules[0].status).toBe(json.status);
    expect(gate.rules[0].shortfall).toBe(json.shortfall);
  });

  test('wiring explain / wiring test render the same settled verdict; they stay informational (0)', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    const explain = await run(wiringCommand, args(root, ['explain', 'subset-rule']));
    expect(explain.code).toBe(0);
    expect(explain.out).toContain('Verdict: not-verified');
    expect(notVerifiedLine(explain.out)).toContain('C_H');

    const candidate = JSON.stringify({
      id: 'cand',
      declared: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' },
      registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' },
    });
    const tried = await run(wiringCommand, args(root, ['test', candidate]));
    expect(tried.code).toBe(0);
    expect(tried.out).toMatch(/^ +status +partial$/m);
    expect(tried.out).toContain('Verdict: not-verified');
  });

  test('check wiring --explain runs under a verdict verb, so it returns the settled exit (2), not 0', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    const text = await run(checkCommand, args(root, ['wiring'], { explain: 'subset-rule' }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(notVerifiedLine(text.out)).toContain('C_H');
    const json = await run(checkCommand, args(root, ['wiring'], { explain: 'subset-rule', json: true }));
    expect(json.code).toBe(ExitCode.NotVerified);
    expect(JSON.parse(json.out).verdict).toBe('not-verified');
  });

  test('registeredExtras: passed / pass / exit 0, with the acceptance printed — never silent', async () => {
    const root = workspace(subsetRule(", registeredExtras: ['C_H']"), SUBSET_FILES);
    const text = await run(gatesExplainCommand, args(root, ['subset-rule']));
    expect(text.out).toMatch(/^ +status +passed$/m);
    expect(text.out).toContain('Verdict: pass');
    expect(text.out).toContain('accepted by registeredExtras');
    expect((await run(checkCommand, args(root, ['wiring'], { explain: 'subset-rule' }))).code).toBe(
      ExitCode.VerifiedPass,
    );
  });
});

// ── #4 --allow-empty on an empty changeset ──────────────────────────────────

describe('#4 --allow-empty is reachable on an EMPTY changeset, and `accepted` only ever sits next to 0', () => {
  function emptyChangeset(): string {
    const root = workspace(
      `${subsetRule(", registeredExtras: ['C_H']")}, policyRules: [{ id: 'p1', surface: 'ts', files: ['src/**/*.ts'], pattern: 'ZZZNEVER', message: 'm', severity: 'error' }]`,
      { ...SUBSET_FILES, 'README.md': 'hi\n' },
    );
    git(root, 'init', '-q');
    commitAll(root, 'init');
    // Only a README changed: no rule's footprint intersects the changeset.
    appendFileSync(join(root, 'README.md'), 'changed\n');
    return root;
  }

  const verbs: { name: string; h: typeof checkCommand; pos: string[] }[] = [
    { name: 'check wiring', h: checkCommand, pos: ['wiring'] },
    { name: 'gates check', h: gatesCheckCommand, pos: [] },
    { name: 'policy-lint', h: policyLintCommand, pos: [] },
  ];

  for (const v of verbs) {
    test(`${v.name} --changed-only: 2 without the valve (shortfall named, nothing accepted); 0 with it`, async () => {
      const root = emptyChangeset();
      const bare = await run(v.h, args(root, v.pos, { 'changed-only': true, json: true }));
      const bareGate = JSON.parse(bare.out).gate;
      expect({ code: bare.code, exit: bareGate.exit }).toEqual({ code: 2, exit: 2 });
      expect(bareGate.coverage.expected).toBe(0);
      expect(bareGate.shortfalls.length).toBeGreaterThan(0);
      expect(bareGate.accepted).toEqual([]);

      const bareText = await run(v.h, args(root, v.pos, { 'changed-only': true }));
      expect(bareText.code).toBe(ExitCode.NotVerified);
      expect(notVerifiedLine(bareText.out)).not.toBe('');
      expect(bareText.out).toContain('--allow-empty');

      const accepted = await run(v.h, args(root, v.pos, { 'changed-only': true, 'allow-empty': true }));
      expect(accepted.code).toBe(ExitCode.VerifiedPass);
      expect(accepted.out).toContain('accepted by --allow-empty');
      const acceptedJson = await run(v.h, args(root, v.pos, { 'changed-only': true, 'allow-empty': true, json: true }));
      const gate = JSON.parse(acceptedJson.out).gate;
      expect({ code: acceptedJson.code, exit: gate.exit, verdict: gate.verdict }).toEqual({
        code: 0,
        exit: 0,
        verdict: 'pass',
      });
      expect(gate.accepted.length).toBe(1);
      expect(gate.shortfalls).toEqual([]);
    }, SLOW);
  }
});

// ── #5 / #2 the plane verdict and the text exit come from the settled exit ──

describe('#5 the plane `verdict` of --json derives from the settled exit', () => {
  test('check wiring --json: `not-verified` next to exitCode 2 (was `pass`)', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    const json = await run(checkCommand, args(root, ['wiring'], { json: true }));
    const parsed = JSON.parse(json.out);
    expect({ code: json.code, exitCode: parsed.exitCode, verdict: parsed.verdict }).toEqual({
      code: 2,
      exitCode: 2,
      verdict: 'not-verified',
    });
  });

  test('policy-lint: a warning finding next to a stale warning rule is 2 in text AND --json, verdict `not-verified`', async () => {
    const root = workspace(
      "policyRules: [ { id: 'warn-todo', surface: 'ts', files: ['src/**/*.ts'], pattern: 'TODO', message: 'no todo', severity: 'warning' }, { id: 'stale-rule', surface: 'ts', files: ['nowhere/**/*.ts'], pattern: 'XQZ', message: 'x', severity: 'warning', failOnEmpty: false } ]",
      { 'src/a.ts': 'export const TODO_A = 1;\n' },
    );
    const text = await run(policyLintCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(notVerifiedLine(text.out)).toContain('stale-rule');
    const json = await run(policyLintCommand, args(root, [], { json: true }));
    const parsed = JSON.parse(json.out);
    expect({ code: json.code, exitCode: parsed.exitCode, verdict: parsed.verdict, gate: parsed.gate.exit }).toEqual({
      code: 2,
      exitCode: 2,
      verdict: 'not-verified',
      gate: 2,
    });
  });

  test('policy-lint: warning findings over a fully-examined scope still exit 0, and say so without a ✓', async () => {
    const root = workspace(
      "policyRules: [ { id: 'warn-todo', surface: 'ts', files: ['src/**/*.ts'], pattern: 'TODO', message: 'no todo', severity: 'warning' } ]",
      { 'src/a.ts': 'export const TODO_A = 1;\n' },
    );
    const text = await run(policyLintCommand, args(root, []));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain('No blocking policy violations — 1 warning(s) reported above.');
    const parsed = JSON.parse((await run(policyLintCommand, args(root, [], { json: true }))).out);
    expect(parsed.verdict).toBe('warnings');
  });
});

// ── #7 check wiring --fix ───────────────────────────────────────────────────

describe('#7 check wiring --fix is settled like the check itself', () => {
  test('"Nothing to fix" over a partial rule is NOT VERIFIED (2) in text and JSON, never 0', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    const text = await run(checkCommand, args(root, ['wiring'], { fix: true }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('Nothing to fix');
    expect(notVerifiedLine(text.out)).toContain('C_H');
    const json = await run(checkCommand, args(root, ['wiring'], { fix: true, json: true }));
    const parsed = JSON.parse(json.out);
    expect({ code: json.code, exitCode: parsed.exitCode, gate: parsed.gate.exit }).toEqual({
      code: 2,
      exitCode: 2,
      gate: 2,
    });
  });

  test('a fixable violation over a fully-examined scope still plans the edit and exits 0 (dry run)', async () => {
    const root = workspace(
      "wiringRules: [{ id: 'reg', declared: { files: ['src/h/*.ts'], extract: 'export-names', match: '_H$' }, registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' } }]",
      { 'src/h/a.ts': 'export const A_H = 1;\n', 'src/h/b.ts': 'export const B_H = 2;\n', 'src/reg.ts': 'export const H = [A_H];\n' },
    );
    const text = await run(checkCommand, args(root, ['wiring'], { fix: true }));
    expect(text.out).toContain('would add B_H');
    expect(text.code).toBe(ExitCode.VerifiedPass);
    const parsed = JSON.parse((await run(checkCommand, args(root, ['wiring'], { fix: true, json: true }))).out);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.edits.length).toBe(1);
  });
});

// ── #1 check orphans ────────────────────────────────────────────────────────

describe('#1 check orphans — a partially-indexed deletion never reads clean', () => {
  /**
   * A repo indexed with src/a.ts and src/usec.ts (which imports ./c before it
   * exists); src/c.ts lands AFTER the index. Deleting c leaves a deleted source
   * file the index never knew, while every SURVIVING file is current in the
   * index — the importer side is fresh here (#1b covers a stale one).
   */
  function orphanRepo(): string {
    const root = workspace('', {
      '.gitignore': '.sharkcraft/\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022' } }),
      'src/a.ts': 'export const A = 1;\n',
      'src/keep.ts': 'export const K = 1;\n',
      'src/usec.ts': "import { C } from './c';\nexport const X = C;\n",
      'README.md': 'hi\n',
    });
    git(root, 'init', '-q');
    commitAll(root, 'init');
    buildFullIndex({ projectRoot: root });
    writeFileSync(join(root, 'src', 'c.ts'), 'export const C = 3;\n');
    commitAll(root, 'add c');
    return root;
  }

  test('an indexed deletion next to an UNINDEXED one: 2, naming the file whose importers were never checked', async () => {
    const root = orphanRepo();
    unlinkSync(join(root, 'src', 'a.ts'));
    unlinkSync(join(root, 'src', 'c.ts'));
    const text = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD' }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('No orphaned importers — nothing still references the deleted code. ✓');
    expect(notVerifiedLine(text.out)).toContain('src/c.ts');
    const json = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD', json: true }));
    const parsed = JSON.parse(json.out);
    expect({ code: json.code, gate: parsed.gate.exit }).toEqual({ code: 2, gate: 2 });
    expect(parsed.gate.coverage).toMatchObject({ unit: 'deleted code files', expected: 2, examined: 1 });
    expect(parsed.gate.coverage.unexamined).toEqual(['src/c.ts']);
  }, SLOW);

  test('a deleted README next to an indexed .ts is out of scope: still clean (0)', async () => {
    const root = orphanRepo();
    // Re-index the PRE-delete tree: c.ts landed after the first index, and a
    // surviving file the index never read would (rightly) keep this at 2.
    buildFullIndex({ projectRoot: root });
    unlinkSync(join(root, 'src', 'a.ts'));
    unlinkSync(join(root, 'README.md'));
    const text = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD' }));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain('No orphaned importers — nothing still references the deleted code. ✓');
  }, SLOW);

  test('deleting only non-source files is "nothing to examine" (2); --allow-empty accepts it and says so', async () => {
    const root = orphanRepo();
    unlinkSync(join(root, 'README.md'));
    const bare = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD' }));
    expect(bare.code).toBe(ExitCode.NotVerified);
    const accepted = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD', 'allow-empty': true }));
    expect(accepted.code).toBe(ExitCode.VerifiedPass);
    expect(accepted.out).toContain('accepted by --allow-empty');
  }, SLOW);
});

// ── #1b check orphans over a STALE index (post-review) ──────────────────────

describe('#1b check orphans — an importer the index never read keeps the answer NOT VERIFIED', () => {
  /** src/a.ts + src/keep.ts, committed and indexed. */
  function indexedRepo(): string {
    const root = workspace('', {
      '.gitignore': '.sharkcraft/\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022' } }),
      'src/a.ts': 'export const A = 1;\n',
      'src/keep.ts': 'export const K = 1;\n',
    });
    git(root, 'init', '-q');
    commitAll(root, 'init');
    buildFullIndex({ projectRoot: root });
    return root;
  }

  /** indexedRepo + src/usea.ts (imports ./a) committed AFTER the index. */
  function staleImporterRepo(): string {
    const root = indexedRepo();
    writeFileSync(join(root, 'src', 'usea.ts'), "import { A } from './a';\nexport const X = A;\n");
    commitAll(root, 'add usea');
    return root;
  }

  test('a NEW importer since the index: 2 in text and JSON, naming it — never the clean line', async () => {
    const root = staleImporterRepo();
    unlinkSync(join(root, 'src', 'a.ts'));
    const text = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD' }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('No orphaned importers — nothing still references the deleted code. ✓');
    expect(text.out).toMatch(/^ +index +stale — 1 file\(s\) changed since it was built$/m);
    expect(text.out).toContain('Index the PRE-delete tree');
    expect(notVerifiedLine(text.out)).toContain('stale index');
    expect(notVerifiedLine(text.out)).toContain('src/usea.ts');

    const json = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD', json: true }));
    const parsed = JSON.parse(json.out);
    expect({ code: json.code, gate: parsed.gate.exit, orphans: parsed.orphans }).toEqual({ code: 2, gate: 2, orphans: [] });
    expect(parsed.gate.coverage).toMatchObject({
      unit: 'deleted code files',
      expected: 1,
      examined: 0,
      unexamined: ['src/a.ts'],
    });
    expect(parsed.indexDivergence).toEqual({ measured: true, changed: ['src/usea.ts'] });
    // --allow-empty accepts an EMPTY scope only — never a stale one.
    const valve = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD', 'allow-empty': true }));
    expect(valve.code).toBe(ExitCode.NotVerified);
  }, SLOW);

  test('the printed remedy works: re-indexing the PRE-delete tree finds the surviving importer (1)', async () => {
    const root = staleImporterRepo();
    buildFullIndex({ projectRoot: root }); // a.ts still on disk: the pre-delete tree
    unlinkSync(join(root, 'src', 'a.ts'));
    const json = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD', json: true }));
    const parsed = JSON.parse(json.out);
    expect(json.code).toBe(ExitCode.Failure);
    expect(parsed.orphans.some((o: { path?: string }) => o.path === 'src/usea.ts')).toBe(true);
    expect(parsed.gate.coverage).toMatchObject({ expected: 1, examined: 1 });
  }, SLOW);

  test('a MODIFIED file counts too — an import of the deleted code it gained after the index was never read', async () => {
    const root = indexedRepo();
    writeFileSync(join(root, 'src', 'keep.ts'), "import { A } from './a';\nexport const K = A;\n");
    unlinkSync(join(root, 'src', 'a.ts'));
    const json = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD', json: true }));
    const parsed = JSON.parse(json.out);
    expect({ code: json.code, orphans: parsed.orphans }).toEqual({ code: 2, orphans: [] });
    expect(parsed.indexDivergence.changed).toEqual(['src/keep.ts']);
  }, SLOW);

  test('finish reads the same authority: its orphans sub-gate is `partial` and the composite is 2', async () => {
    const root = staleImporterRepo();
    unlinkSync(join(root, 'src', 'a.ts'));
    const report = await runFinishGates({ cwd: root, mode: 'since', scope: { projectRoot: root, since: 'HEAD' } });
    const orphans = report.gates.find((g) => g.name === 'orphans');
    expect(orphans?.status).toBe('partial');
    expect(orphans?.shortfall).toContain('src/usea.ts');
    expect(orphans?.coverage).toMatchObject({ unit: 'deleted code files', expected: 1, examined: 0 });
    expect({ verdict: report.verdict, exit: report.exit }).toEqual({ verdict: 'not-verified', exit: 2 });
    expect(report.summary).toContain('orphans:');
  }, SLOW);
});

// ── #1c the orphan scope is what the index can hold (post-review) ───────────

describe('#1c a deleted dist/*.js is out of the orphan scope — no index ever holds one', () => {
  function distRepo(): string {
    const root = workspace('', {
      '.gitignore': '.sharkcraft/\n',
      'src/a.ts': 'export const A = 1;\n',
      'src/keep.ts': 'export const K = 1;\n',
      'dist/d.js': 'export const D = 1;\n',
    });
    git(root, 'init', '-q');
    commitAll(root, 'init');
    buildFullIndex({ projectRoot: root });
    return root;
  }

  test('deleting a tracked dist/d.js next to an indexed src/a.ts reads clean (0), examined 1 of 1', async () => {
    const root = distRepo();
    unlinkSync(join(root, 'src', 'a.ts'));
    unlinkSync(join(root, 'dist', 'd.js'));
    const text = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD' }));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain('No orphaned importers — nothing still references the deleted code. ✓');
    const parsed = JSON.parse((await run(checkCommand, args(root, ['orphans'], { since: 'HEAD', json: true }))).out);
    expect(parsed.gate.coverage).toMatchObject({ expected: 1, examined: 1 });
  }, SLOW);

  test('deleting only dist/d.js is "nothing to examine" (2), and --allow-empty clears it (0)', async () => {
    const root = distRepo();
    unlinkSync(join(root, 'dist', 'd.js'));
    expect((await run(checkCommand, args(root, ['orphans'], { since: 'HEAD' }))).code).toBe(ExitCode.NotVerified);
    const accepted = await run(checkCommand, args(root, ['orphans'], { since: 'HEAD', 'allow-empty': true }));
    expect(accepted.code).toBe(ExitCode.VerifiedPass);
    expect(accepted.out).toContain('accepted by --allow-empty');
  }, SLOW);
});

// ── #6 finish's wiring sub-gate ─────────────────────────────────────────────

describe("#6 finish's wiring sub-gate settles on the rule coverage", () => {
  test('a partial subset rule in the changeset: the composite is not-verified (2), the sub-gate carries the shortfall', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    git(root, 'init', '-q');
    commitAll(root, 'init');
    writeFileSync(join(root, 'src', 'h', 'a.ts'), 'export const A_H = 11;\n');
    const report = await runFinishGates({
      cwd: root,
      mode: 'worktree',
      scope: { projectRoot: root, includeWorktree: true },
    });
    const wiring = report.gates.find((g) => g.name === 'wiring');
    // Settled ONCE in runFinishGates: `partial`, with the shortfall on the gate.
    expect(wiring?.status).toBe('partial');
    expect(wiring?.shortfall).toContain('subset-rule');
    expect(wiring?.coverage?.expected).toBe(1);
    expect(wiring?.coverage?.examined).toBe(0);
    expect(wiring?.detail).toContain('C_H');
    expect({ verdict: report.verdict, exit: report.exit }).toEqual({ verdict: 'not-verified', exit: 2 });
    expect(report.summary).toContain('wiring:');
  }, SLOW);

  test('text and --json report the SAME status word for the partial sub-gate', async () => {
    const root = workspace(subsetRule(), SUBSET_FILES);
    git(root, 'init', '-q');
    commitAll(root, 'init');
    writeFileSync(join(root, 'src', 'h', 'a.ts'), 'export const A_H = 11;\n');
    const json = await run(finishCommand, args(root, [], { json: true }));
    const parsed = JSON.parse(json.out);
    const wiring = parsed.gates.find((g: { name: string }) => g.name === 'wiring');
    expect({ code: json.code, status: wiring.status }).toEqual({ code: 2, status: 'partial' });
    const text = await run(finishCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toMatch(/^ +~ wiring +partial /m);
    expect(text.out).not.toMatch(/^ +✓ wiring /m);
  }, SLOW);
});

// ── #10 shrk gate settles its exit on gate coverage (post-review) ───────────

describe('#10 `shrk gate` — a gate that says "this is not a pass" never exits 0', () => {
  function gateRepo(extra = ''): string {
    const root = workspace(subsetRule(extra), { ...SUBSET_FILES, '.gitignore': '.sharkcraft/\n' });
    git(root, 'init', '-q');
    commitAll(root, 'init');
    buildFullIndex({ projectRoot: root });
    return root;
  }

  test('a partial wiring rule: 2 in text, --json and --markdown; --strict still escalates the warn to 1', async () => {
    const root = gateRepo();
    const text = await run(gateCommand, args(root, [], { 'no-persist': true }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(notVerifiedLine(text.out)).toContain('subset-rule');
    expect(notVerifiedLine(text.out)).toContain('C_H');

    const json = await run(gateCommand, args(root, [], { 'no-persist': true, json: true }));
    const parsed = JSON.parse(json.out);
    expect({ code: json.code, exitCode: parsed.exitCode, verdict: parsed.verdict, overall: parsed.overall }).toEqual({
      code: 2,
      exitCode: 2,
      verdict: 'not-verified',
      overall: 'warn',
    });
    expect(parsed.shortfalls[0]).toStartWith('subset-rule: ');
    const wiring = parsed.gates.find((g: { id: string }) => g.id === 'wiring');
    expect(wiring.coverage[0].subject).toBe('subset-rule');

    const md = await run(gateCommand, args(root, [], { 'no-persist': true, markdown: true }));
    expect(md.code).toBe(ExitCode.NotVerified);
    expect(md.out).toContain('NOT VERIFIED');

    expect((await run(gateCommand, args(root, [], { 'no-persist': true, strict: true }))).code).toBe(ExitCode.Failure);
  }, SLOW);

  test('registeredExtras accepts the extra explicitly: exit 0, and the acceptance is printed', async () => {
    const root = gateRepo(", registeredExtras: ['C_H']");
    const text = await run(gateCommand, args(root, [], { 'no-persist': true }));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain('accepted by registeredExtras');
  }, SLOW);
});

// ── #11–#13 a SELECTED rule that examined nothing (third review) ────────────

/** One wiring rule whose DECLARED glob matches nothing; its registered side is src/reg.ts. */
function staleWiringRule(severity: 'warning' | 'error'): string {
  const flags = severity === 'warning' ? "severity: 'warning', failOnEmpty: false, " : '';
  return (
    `wiringRules: [{ id: 'w-stale', ${flags}` +
    "declared: { files: ['nowhere/*.ts'], extract: 'export-names' }, " +
    "registered: { files: ['src/reg.ts'], extract: 'array-members', anchor: 'H' } }]"
  );
}

const LIVE_POLICY =
  "{ id: 'live', surface: 'ts', files: ['src/**/*.ts'], pattern: 'ZZZNEVER', message: 'm', severity: 'warning' }";
const STALE_POLICY =
  "{ id: 'stale', surface: 'ts', files: ['nowhere/**/*.ts'], pattern: 'XQZ', message: 'x', severity: 'warning', failOnEmpty: false }";

describe('#11 finish — a SELECTED rule that examined nothing is never "Safe to finish"', () => {
  /** Committed; then the rule's registered footprint (src/reg.ts) is edited, so the rule is selected. */
  function staleWiringRepo(severity: 'warning' | 'error'): string {
    const root = workspace(staleWiringRule(severity), {
      '.gitignore': '.sharkcraft/\n',
      'src/reg.ts': 'export const H = [];\n',
    });
    git(root, 'init', '-q');
    commitAll(root, 'init');
    writeFileSync(join(root, 'src', 'reg.ts'), 'export const H = [ ];\n');
    return root;
  }

  test('warning rule: the wiring sub-gate is `partial` and finish is 2 — exactly `check wiring --changed-only`', async () => {
    const root = staleWiringRepo('warning');
    expect((await run(checkCommand, args(root, ['wiring'], { 'changed-only': true }))).code).toBe(ExitCode.NotVerified);
    const json = await run(finishCommand, args(root, [], { json: true }));
    const parsed = JSON.parse(json.out);
    const wiring = parsed.gates.find((g: { name: string }) => g.name === 'wiring');
    expect({ code: json.code, verdict: parsed.verdict, status: wiring.status }).toEqual({
      code: 2,
      verdict: 'not-verified',
      status: 'partial',
    });
    expect(wiring.shortfall).toContain('w-stale');
    expect(wiring.coverage).toMatchObject({ unit: 'wiring rules', expected: 1, examined: 0 });
    const text = await run(finishCommand, args(root, []));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('Safe to finish');
    expect(text.out).toMatch(/^ +~ wiring +partial /m);
  }, SLOW);

  test('error rule (failOnEmpty by default): the sub-gate FAILS and finish is 1 — exactly `check wiring --changed-only`', async () => {
    const root = staleWiringRepo('error');
    expect((await run(checkCommand, args(root, ['wiring'], { 'changed-only': true }))).code).toBe(ExitCode.Failure);
    const json = await run(finishCommand, args(root, [], { json: true }));
    const parsed = JSON.parse(json.out);
    const wiring = parsed.gates.find((g: { name: string }) => g.name === 'wiring');
    expect({ code: json.code, verdict: parsed.verdict, status: wiring.status }).toEqual({
      code: 1,
      verdict: 'fail',
      status: 'fail',
    });
    expect(wiring.errors).toBe(1);
    expect(
      wiring.items.some((i: { message: string }) => i.message.includes('w-stale') && i.message.includes('failOnEmpty')),
    ).toBe(true);
  }, SLOW);

  test('policy: a changed file the scan left UNREAD (size cap) keeps its rule in scope — `partial`, like `policy-lint --changed-only`', async () => {
    const root = workspace(`policyRules: [ ${LIVE_POLICY.replace("'live'", "'big'")} ]`, {
      '.gitignore': '.sharkcraft/\n',
      'src/big.ts': 'export const B = 1;\n',
    });
    git(root, 'init', '-q');
    commitAll(root, 'init');
    writeFileSync(join(root, 'src', 'big.ts'), `export const B = 2; // ${'x'.repeat(1_000_100)}\n`);
    expect((await run(policyLintCommand, args(root, [], { 'changed-only': true }))).code).toBe(ExitCode.NotVerified);
    const report = await runFinishGates({ cwd: root, mode: 'worktree', scope: { projectRoot: root, includeWorktree: true } });
    const policy = report.gates.find((g) => g.name === 'policy');
    expect(policy?.status).toBe('partial');
    expect(policy?.shortfall).toContain('big');
    expect(report.exit).toBe(ExitCode.NotVerified);
  }, SLOW);

  test('policy: a PURE deletion puts nothing in scope — the sub-gate skips, never failOnEmpty\'s 1', async () => {
    // Error severity → failOnEmpty on. This used to fail `policy-lint
    // --changed-only` (1) on a plain delete; finish must not inherit that.
    const root = workspace(
      "policyRules: [ { id: 'no-zzz', surface: 'ts', files: ['src/**/*.ts'], pattern: 'ZZZNEVER', message: 'm' } ]",
      { '.gitignore': '.sharkcraft/\n', 'src/a.ts': 'export const A = 1;\n', 'src/b.ts': 'export const B = 1;\n' },
    );
    git(root, 'init', '-q');
    commitAll(root, 'init');
    unlinkSync(join(root, 'src', 'b.ts'));
    const lint = await run(policyLintCommand, args(root, [], { 'changed-only': true, json: true }));
    expect({ code: lint.code, rules: JSON.parse(lint.out).rules }).toEqual({ code: 2, rules: [] });
    expect((await run(policyLintCommand, args(root, [], { 'changed-only': true, 'allow-empty': true }))).code).toBe(
      ExitCode.VerifiedPass,
    );
    const report = await runFinishGates({ cwd: root, mode: 'worktree', scope: { projectRoot: root, includeWorktree: true } });
    expect(report.gates.find((g) => g.name === 'policy')?.status).toBe('skipped');
    expect(report.verdict).not.toBe('fail');
  }, SLOW);
});

describe('#12 `shrk gate` — its wiring and policy gates settle a selected rule that examined nothing', () => {
  function indexed(planes: string, files: Record<string, string>): string {
    const root = workspace(planes, { '.gitignore': '.sharkcraft/\n', ...files });
    git(root, 'init', '-q');
    commitAll(root, 'init');
    buildFullIndex({ projectRoot: root });
    return root;
  }

  test('one wiring rule whose declared glob matches nothing (warning): 2 in text and --json, like `check wiring`', async () => {
    const root = indexed(staleWiringRule('warning'), { 'src/reg.ts': 'export const H = [];\n' });
    expect((await run(checkCommand, args(root, ['wiring']))).code).toBe(ExitCode.NotVerified);
    const text = await run(gateCommand, args(root, [], { 'no-persist': true }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('[skipped ] Wiring');
    expect(notVerifiedLine(text.out)).toContain('w-stale');
    const parsed = JSON.parse((await run(gateCommand, args(root, [], { 'no-persist': true, json: true }))).out);
    expect({ exitCode: parsed.exitCode, verdict: parsed.verdict }).toEqual({ exitCode: 2, verdict: 'not-verified' });
    expect(parsed.gates.find((g: { id: string }) => g.id === 'wiring').status).toBe('warn');
  }, SLOW);

  test('the same rule at error severity (failOnEmpty by default): 1, like `check wiring`', async () => {
    const root = indexed(staleWiringRule('error'), { 'src/reg.ts': 'export const H = [];\n' });
    expect((await run(checkCommand, args(root, ['wiring']))).code).toBe(ExitCode.Failure);
    expect((await run(gateCommand, args(root, [], { 'no-persist': true }))).code).toBe(ExitCode.Failure);
  }, SLOW);

  test('policy: a live rule next to a stale warning rule is 2 (was `[pass] Policy lint`, exit 0), like `policy-lint`', async () => {
    const root = indexed(`policyRules: [ ${LIVE_POLICY}, ${STALE_POLICY} ]`, { 'src/a.ts': 'export const A = 1;\n' });
    expect((await run(policyLintCommand, args(root, []))).code).toBe(ExitCode.NotVerified);
    const text = await run(gateCommand, args(root, [], { 'no-persist': true }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('[pass    ] Policy lint');
    expect(notVerifiedLine(text.out)).toContain('stale: ');
    const parsed = JSON.parse((await run(gateCommand, args(root, [], { 'no-persist': true, json: true }))).out);
    expect({ exitCode: parsed.exitCode, verdict: parsed.verdict }).toEqual({ exitCode: 2, verdict: 'not-verified' });
  }, SLOW);

  test('policy: ONLY a stale warning rule is 2, not `[skipped]` and 0', async () => {
    const root = indexed(`policyRules: [ ${STALE_POLICY} ]`, { 'src/a.ts': 'export const A = 1;\n' });
    expect((await run(policyLintCommand, args(root, []))).code).toBe(ExitCode.NotVerified);
    const text = await run(gateCommand, args(root, [], { 'no-persist': true }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toContain('[skipped ] Policy lint');
  }, SLOW);
});

describe('#13 impact --deleted settles on the orphan coverage authority, like `check orphans`', () => {
  /** src/a.ts + src/keep.ts, committed and indexed. */
  function indexedRepo(): string {
    const root = workspace('', {
      '.gitignore': '.sharkcraft/\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler', target: 'es2022' } }),
      'src/a.ts': 'export const A = 1;\n',
      'src/keep.ts': 'export const K = 1;\n',
    });
    git(root, 'init', '-q');
    commitAll(root, 'init');
    buildFullIndex({ projectRoot: root });
    return root;
  }

  /** indexedRepo + src/usea.ts (imports ./a) committed AFTER the index. */
  function staleImporterRepo(): string {
    const root = indexedRepo();
    writeFileSync(join(root, 'src', 'usea.ts'), "import { A } from './a';\nexport const X = A;\n");
    commitAll(root, 'add usea');
    return root;
  }

  test('a NEW importer since the index: 2 in text and --json — never "no orphaned importers"', async () => {
    const root = staleImporterRepo();
    unlinkSync(join(root, 'src', 'a.ts'));
    const text = await run(impactCommand, args(root, [], { deleted: true, since: 'HEAD' }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).not.toMatch(/^no orphaned importers$/m);
    expect(text.out).toMatch(/^ +index +stale — 1 file\(s\) changed since it was built$/m);
    expect(text.out).toContain('then re-run `shrk impact --deleted`');
    expect(notVerifiedLine(text.out)).toContain('src/usea.ts');

    const parsed = JSON.parse((await run(impactCommand, args(root, [], { deleted: true, since: 'HEAD', json: true }))).out);
    expect({ exitCode: parsed.exitCode, verdict: parsed.verdict, orphans: parsed.orphans }).toEqual({
      exitCode: 2,
      verdict: 'not-verified',
      orphans: [],
    });
    expect(parsed.indexDivergence).toEqual({ measured: true, changed: ['src/usea.ts'] });
    expect(parsed.coverage).toMatchObject({ unit: 'deleted code files', expected: 1, examined: 0 });
    // One question, one authority: `check orphans` reads the same exit.
    expect((await run(checkCommand, args(root, ['orphans'], { since: 'HEAD' }))).code).toBe(ExitCode.NotVerified);
    // --allow-empty accepts an EMPTY scope only — never a stale one.
    expect(
      (await run(impactCommand, args(root, [], { deleted: true, since: 'HEAD', 'allow-empty': true }))).code,
    ).toBe(ExitCode.NotVerified);
  }, SLOW);

  test('re-indexing the PRE-delete tree finds the importer (1); a delete over a current index reads clean (0)', async () => {
    const root = staleImporterRepo();
    buildFullIndex({ projectRoot: root }); // a.ts still on disk: the pre-delete tree
    unlinkSync(join(root, 'src', 'a.ts'));
    expect((await run(impactCommand, args(root, [], { deleted: true, since: 'HEAD' }))).code).toBe(ExitCode.Failure);

    const clean = indexedRepo();
    unlinkSync(join(clean, 'src', 'keep.ts')); // nothing imports keep.ts
    const ok = await run(impactCommand, args(clean, [], { deleted: true, since: 'HEAD' }));
    expect(ok.code).toBe(ExitCode.VerifiedPass);
    expect(ok.out).toMatch(/^no orphaned importers$/m);
  }, SLOW);

  test('nothing deleted is "nothing to examine" (2); --allow-empty accepts it and says so (0)', async () => {
    const root = indexedRepo();
    const bare = await run(impactCommand, args(root, [], { deleted: true, since: 'HEAD' }));
    expect(bare.code).toBe(ExitCode.NotVerified);
    expect(bare.out).toContain('--allow-empty');
    const accepted = await run(impactCommand, args(root, [], { deleted: true, since: 'HEAD', 'allow-empty': true }));
    expect(accepted.code).toBe(ExitCode.VerifiedPass);
    expect(accepted.out).toContain('accepted by --allow-empty');
  }, SLOW);
});

// ── #8 the verdict-verb registry ────────────────────────────────────────────

describe('#8 the verdict-verb registry reads one token deeper than the usage record', () => {
  test('`docs references check` is a verdict verb; `docs references list` / `explain` are not', () => {
    expect(isGateVerb('docs references check')).toBe(true);
    expect(isGateVerb('docs references list')).toBe(false);
    expect(isGateVerb('docs references explain')).toBe(false);
    // Shallower entries still cover every deeper path under them.
    expect(isGateVerb('graph why a')).toBe(true);
    expect(isGateVerb('check wiring')).toBe(true);
    // The trailer path keeps three tokens; the usage record keeps two.
    expect(extractCommandPath(['docs', 'references', 'check', '--json'], VERDICT_PATH_TOKENS)).toBe(
      'docs references check',
    );
    expect(extractCommandPath(['docs', 'references', 'check'])).toBe('docs references');
    for (const p of GATE_VERB_PATHS) {
      expect({ p, tokens: p.split(' ').length <= VERDICT_PATH_TOKENS }).toEqual({ p, tokens: true });
    }
  });

  test('spawned from source: --exit-trailer fires for `docs references check`, not for `list`', () => {
    const root = workspace('');
    const check = spawnSync('bun', ['run', CLI_MAIN, 'docs', 'references', 'check', '--exit-trailer'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(check.stderr).toContain(`shrk-exit: ${check.status}`);
    const list = spawnSync('bun', ['run', CLI_MAIN, 'docs', 'references', 'list', '--exit-trailer'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(list.stderr).not.toContain('shrk-exit:');
  }, SLOW);
});
