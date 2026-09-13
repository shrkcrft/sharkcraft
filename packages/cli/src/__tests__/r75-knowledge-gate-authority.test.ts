/**
 * Round 11 review — the knowledge stale-check verdict has ONE authority.
 *
 *   1. `--changed-only` / `--files` scope: the entry whose own file changed,
 *      and a directory reference above a changed (or deleted) path, are IN
 *      scope — a typo in a new reference fails the run that introduced it.
 *   2. A knowledge-bearing file that failed to load (or is declared and
 *      missing) is never a pass: a clean sweep of the rest settles to 2, and
 *      `--allow-empty` never clears it.
 *   3. One input builder: for a config-only request, the verb's exit, the
 *      `shrk quality` item and `release readiness` `knowledgeCheck.ready` are
 *      one answer (they used to read `knowledgeCheck` three ways).
 *   4. A `count` never walks the sharkcraft dir by default (the claim would
 *      count itself).
 *   5. `aged` / `--as-of` with no `--stale-after` window is a usage error.
 *
 * Every fixture is a real workspace loaded by the real config loader and
 * inspector, driven through the real command handlers (git fixtures live in
 * their own temp repos).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadProjectConfig } from '@shrkcrft/config';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import type { ParsedArgs } from '../command-registry.ts';
import { knowledgeStaleCheckCommand } from '../commands/knowledge.command.ts';
import { releaseCommand } from '../commands/release.command.ts';
import { ExitCode } from '../exit-codes.ts';
import { KNOWLEDGE_FAIL_ON_CATEGORIES } from '../knowledge/knowledge-stale-gate.ts';
import { runQuality } from '../quality/run-quality.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** ParsedArgs exactly as `parseArgs` builds them: every string flag also lands in `multiFlags`. */
function args(cwd: string, positional: string[] = [], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', cwd], ...Object.entries(flags)]),
    multiFlags: new Map(
      Object.entries(flags)
        .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
        .map(([k, v]) => [k, [v]]),
    ),
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

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-kauth-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** git inside a fixture's own temp repo — never the working tree. */
function git(root: string, ...a: string[]): void {
  const r = spawnSync(
    'git',
    ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', '-c', 'commit.gpgsign=false', ...a],
    { cwd: root, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${r.stderr}`);
}

function commitAll(root: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
}

/** One knowledge entry literal; `refs` is a JS array literal or omitted. */
function entry(id: string, refs?: string, extra = ''): string {
  return (
    `{ id: '${id}', title: '${id}', type: 'technical', priority: 'medium', scope: [], tags: [], ` +
    `appliesWhen: [], content: 'About ${id}.'${refs ? `, references: ${refs}` : ''}${extra ? `, ${extra}` : ''} }`
  );
}

function knowledgeFile(entries: readonly string[]): string {
  return `export default [\n  ${entries.join(',\n  ')}\n];\n`;
}

function configFile(extra = ''): string {
  return `export default { projectName: 'kauth', knowledgeFiles: ['knowledge.ts']${extra ? `, ${extra}` : ''} };\n`;
}

/** A real workspace: package.json, src/a.ts, sharkcraft/knowledge.ts and a config. */
function workspace(entries: readonly string[], configExtra = '', files: Record<string, string> = {}): string {
  return tree({
    'package.json': JSON.stringify({ name: 'kauth', version: '0.0.0' }),
    'src/a.ts': 'export const A = 1;\n',
    'sharkcraft/knowledge.ts': knowledgeFile(entries),
    'sharkcraft/sharkcraft.config.ts': configFile(configExtra),
    ...files,
  });
}

const FILE_REF = "[{ kind: 'file', path: 'src/a.ts' }]";
/** A clean sentence — never printed unless the settled exit is 0. */
const CLEAN = /\.\s*✓|— accepted\.\s*$/m;
/** A TS file that cannot be imported. */
const SYNTAX_ERROR = "export default [ { id: 'r.one', title: 'one', type: 'rule',\n";

describe('1 — --changed-only puts every subject the change can break in scope', () => {
  test('editing an entry puts it in scope: a typo in a NEW reference fails the run that introduced it', async () => {
    const root = workspace([entry('k.one', FILE_REF)]);
    git(root, 'init', '-q');
    commitAll(root);
    writeFileSync(
      join(root, 'sharkcraft/knowledge.ts'),
      knowledgeFile([entry('k.one', "[{ kind: 'file', path: 'src/a.ts' }, { kind: 'file', path: 'src/typo-new.ts' }]")]),
    );
    expect((await run(knowledgeStaleCheckCommand, args(root))).code).toBe(ExitCode.Failure);
    const scoped = await run(knowledgeStaleCheckCommand, args(root, [], { 'changed-only': true }));
    expect(scoped.code).toBe(ExitCode.Failure);
    expect(scoped.out).toContain('src/typo-new.ts');
    expect(scoped.out).not.toMatch(CLEAN);
    const j = JSON.parse((await run(knowledgeStaleCheckCommand, args(root, [], { 'changed-only': true, json: true }))).out);
    expect(j.entriesInScope).toBe(1);
    expect(j.gate.exit).toBe(ExitCode.Failure);
    // --allow-empty accepts an EMPTY scope only — this one is not empty.
    const allow = await run(knowledgeStaleCheckCommand, args(root, [], { 'changed-only': true, 'allow-empty': true }));
    expect(allow.code).toBe(ExitCode.Failure);
    expect(allow.out).not.toContain('accepted by --allow-empty');
  }, 60_000);

  test('deleting a referenced directory puts the directory reference in scope', async () => {
    const root = workspace([entry('k.dir', "[{ kind: 'directory', path: 'src/svc' }]")], '', {
      'src/svc/x.ts': 'export const X = 1;\n',
    });
    git(root, 'init', '-q');
    commitAll(root);
    rmSync(join(root, 'src/svc'), { recursive: true, force: true });
    expect((await run(knowledgeStaleCheckCommand, args(root))).code).toBe(ExitCode.Failure);
    const variants: Record<string, string | boolean>[] = [
      { 'changed-only': true },
      { 'changed-only': true, 'allow-empty': true },
      { files: 'src/svc/x.ts' },
    ];
    for (const flags of variants) {
      const r = await run(knowledgeStaleCheckCommand, args(root, [], flags));
      expect({ flags, code: r.code }).toEqual({ flags, code: ExitCode.Failure });
      expect(r.out).not.toContain('none of the 1 knowledge entries references the changed files');
      expect(r.out).not.toMatch(CLEAN);
    }
  }, 60_000);
});

describe('2 — a knowledge file that never loaded is never a pass', () => {
  test('partial corpus: rules.ts fails to import → 2 naming the file, though every loaded entry verified', async () => {
    const root = workspace([entry('k.one', FILE_REF)], "ruleFiles: ['rules.ts']", {
      'sharkcraft/rules.ts': SYNTAX_ERROR,
    });
    const r = await run(knowledgeStaleCheckCommand, args(root));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.out).toContain('LOAD FAILED (1 of 2 knowledge files)');
    expect(r.out).toContain('sharkcraft/rules.ts');
    expect(r.out).toContain('NOT VERIFIED');
    expect(r.out).not.toMatch(CLEAN);
    const jr = await run(knowledgeStaleCheckCommand, args(root, [], { json: true }));
    const j = JSON.parse(jr.out);
    expect(jr.code).toBe(ExitCode.NotVerified);
    expect(j.gate.exit).toBe(ExitCode.NotVerified);
    expect(j.gate.verdict).toBe('not-verified');
    const files = j.gate.rules.find((x: { id: string }) => x.id === 'knowledge-files');
    expect(files).toMatchObject({
      type: 'knowledge',
      status: 'error',
      coverage: { unit: 'knowledge files', expected: 2, examined: 1 },
    });
    expect(j.discovery.knowledgeLoadFailures).toEqual([
      expect.objectContaining({ file: 'sharkcraft/rules.ts', kind: 'rules', status: 'failed' }),
    ]);
    // --allow-empty never accepts a load failure.
    expect((await run(knowledgeStaleCheckCommand, args(root, [], { 'allow-empty': true }))).code).toBe(
      ExitCode.NotVerified,
    );
  }, 60_000);

  test('whole corpus: knowledge.ts fails — the reason names the file; --allow-empty does not clear it', async () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'kauth', version: '0.0.0' }),
      'sharkcraft/knowledge.ts': SYNTAX_ERROR,
      'sharkcraft/sharkcraft.config.ts': configFile(),
    });
    const r = await run(knowledgeStaleCheckCommand, args(root));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.out).toContain('sharkcraft/knowledge.ts');
    expect(r.out).not.toContain('no knowledge entries are declared');
    const variants: Record<string, string | boolean>[] = [
      { 'allow-empty': true },
      { files: 'sharkcraft/knowledge.ts', 'allow-empty': true },
    ];
    for (const flags of variants) {
      const a = await run(knowledgeStaleCheckCommand, args(root, [], flags));
      expect({ flags, code: a.code }).toEqual({ flags, code: ExitCode.NotVerified });
      expect(a.out).not.toContain('accepted by --allow-empty');
      expect(a.out).not.toMatch(CLEAN);
    }
  }, 60_000);

  test('a configured knowledge file that does not exist is recorded (loader status `missing`) and refuses', async () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'kauth', version: '0.0.0' }),
      'sharkcraft/sharkcraft.config.ts':
        "export default { projectName: 'kauth', knowledgeFiles: ['missing-knowledge.ts'] };\n",
    });
    const inspection = await inspectSharkcraft({ cwd: root });
    expect(
      inspection.loaderDiagnostics.some((d) => d.status === 'missing' && d.filePath.endsWith('missing-knowledge.ts')),
    ).toBe(true);
    const r = await run(knowledgeStaleCheckCommand, args(root, [], { 'allow-empty': true, json: true }));
    expect(r.code).toBe(ExitCode.NotVerified);
    const j = JSON.parse(r.out);
    expect(j.discovery.knowledgeLoadFailures[0]).toMatchObject({
      file: 'sharkcraft/missing-knowledge.ts',
      status: 'missing',
    });
    expect(j.gate.accepted).toEqual([]);
  }, 60_000);
});

interface ICombo {
  readonly label: string;
  readonly entries: readonly string[];
  readonly knowledgeCheck: string;
  readonly exit: number;
}

const NON_REQUIRED_STALE = [entry('k.ok', FILE_REF), entry('k.bad', "[{ kind: 'file', path: 'src/gone.ts' }]")];
const ZERO_REFERENCES = [entry('k.z1'), entry('k.z2')];
const HALF_REFERENCED = [entry('k.ok', FILE_REF), entry('k.u1')];
const MALFORMED = [entry('k.ok', FILE_REF), entry('k.bad', "[{ kind: 'not-a-kind', path: 'src/a.ts' }]")];

const COMBOS: readonly ICombo[] = [
  { label: 'zero references, enabled → 2', entries: ZERO_REFERENCES, knowledgeCheck: '{ enabled: true }', exit: 2 },
  { label: 'non-required stale, enabled → 1', entries: NON_REQUIRED_STALE, knowledgeCheck: '{ enabled: true }', exit: 1 },
  {
    label: "non-required stale, failOn ['required'] → 0",
    entries: NON_REQUIRED_STALE,
    knowledgeCheck: "{ enabled: true, failOn: ['required'] }",
    exit: 0,
  },
  {
    label: "strict: true promotes any stale over failOn ['required'] → 1",
    entries: NON_REQUIRED_STALE,
    knowledgeCheck: "{ enabled: true, strict: true, failOn: ['required'] }",
    exit: 1,
  },
  {
    label: 'minReferenced 0.5 accepts a 50% remainder → 0',
    entries: HALF_REFERENCED,
    knowledgeCheck: '{ enabled: true, minReferenced: 0.5 }',
    exit: 0,
  },
  {
    label: 'requireReferences fails an unverifiable entry → 1',
    entries: HALF_REFERENCED,
    knowledgeCheck: '{ enabled: true, requireReferences: true }',
    exit: 1,
  },
  {
    label: "failOn ['invalid'] fails a malformed reference → 1",
    entries: MALFORMED,
    knowledgeCheck: "{ enabled: true, failOn: ['invalid'] }",
    exit: 1,
  },
  {
    label: "failOn ['aged'] with no window is a usage error → 3",
    entries: NON_REQUIRED_STALE,
    knowledgeCheck: "{ enabled: true, failOn: ['aged'] }",
    exit: 3,
  },
];

/** The quality item status each settled verb exit maps to. */
const QUALITY_STATUS: Readonly<Record<number, string>> = { 0: 'passed', 1: 'failed', 2: 'skipped', 3: 'error' };

describe('3 — one vocabulary: every --fail-on category is a valid knowledgeCheck.failOn', () => {
  test('the config loads with every KNOWLEDGE_FAIL_ON_CATEGORIES member (a flag the config rejects is a second vocabulary)', async () => {
    const root = workspace(
      [entry('k.ok', FILE_REF)],
      `knowledgeCheck: { failOn: [${KNOWLEDGE_FAIL_ON_CATEGORIES.map((c) => `'${c}'`).join(', ')}] }`,
    );
    const loaded = await loadProjectConfig(root);
    expect(loaded.ok).toBe(true);
    const got: readonly string[] = loaded.ok ? (loaded.value.config.knowledgeCheck?.failOn ?? []) : [];
    expect([...got]).toEqual([...KNOWLEDGE_FAIL_ON_CATEGORIES]);
  }, 60_000);
});

describe('3 — one input, three readers: verb exit ≡ quality item ≡ readiness knowledgeCheck.ready', () => {
  for (const c of COMBOS) {
    test(c.label, async () => {
      const root = workspace(c.entries, `knowledgeCheck: ${c.knowledgeCheck}`);
      const verb = await run(knowledgeStaleCheckCommand, args(root));
      expect({ label: c.label, exit: verb.code }).toEqual({ label: c.label, exit: c.exit });

      const inspection = await inspectSharkcraft({ cwd: root });
      const quality = await runQuality({
        inspection,
        config: {},
        strict: false,
        failFast: false,
        gateRules: [],
        cwd: root,
        excludeDirs: [],
      });
      const item = quality.items.find((i) => i.id === 'knowledge-stale');
      const status: string | undefined = item?.status;
      expect({ label: c.label, status }).toEqual({ label: c.label, status: QUALITY_STATUS[c.exit] });

      const rr = await run(releaseCommand, args(root, ['readiness'], { json: true }));
      const readiness = JSON.parse(rr.out);
      expect({ label: c.label, ready: readiness.knowledgeCheck.ready, exit: readiness.knowledgeCheck.exit }).toEqual({
        label: c.label,
        ready: c.exit === 0,
        exit: c.exit,
      });
      const blocker = readiness.blockers.some((b: { id: string }) => b.id === 'knowledge-check');
      expect(blocker).toBe(c.exit !== 0);
      if (c.exit !== 0) expect(readiness.ready).toBe(false);
    }, 120_000);
  }
});

describe('4 — a count never walks the sharkcraft dir by default', () => {
  const COUNTED = 'registerService("alpha");\nregisterService("beta");\n';
  const countEntry = (glob: string, expected: number): string =>
    String.raw`export default [{ id: 'k.count', title: 'Count', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'Services register each via registerService("<name>") in src/a.ts.', references: [{ kind: 'file', path: 'src/a.ts', count: { source: { files: ['` +
    glob +
    String.raw`'], pattern: 'registerService\\("([a-z<>]+)"\\)' }, expected: ` +
    String(expected) +
    `, measure: 'ids' } }] }];\n`;

  test('prose describing the counted call, inside the count glob, does not count itself', async () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'kauth', version: '0.0.0' }),
      'src/a.ts': COUNTED,
      'sharkcraft/knowledge.ts': countEntry('**/*.ts', 2),
      'sharkcraft/sharkcraft.config.ts': configFile(),
    });
    const r = await run(knowledgeStaleCheckCommand, args(root, [], { json: true }));
    const j = JSON.parse(r.out);
    expect(j.referenceChecks[0]).toMatchObject({ outcome: 'ok', expected: 2, actual: 2 });
    expect(r.code).toBe(ExitCode.VerifiedPass);
  }, 60_000);

  test('a count whose own globs target the sharkcraft dir still walks it', async () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'kauth', version: '0.0.0' }),
      'src/a.ts': COUNTED,
      'sharkcraft/knowledge.ts': countEntry('sharkcraft/**/*.ts', 1),
      'sharkcraft/sharkcraft.config.ts': configFile(),
    });
    const r = await run(knowledgeStaleCheckCommand, args(root, [], { json: true }));
    const j = JSON.parse(r.out);
    expect(j.referenceChecks[0]).toMatchObject({ outcome: 'ok', expected: 1, actual: 1 });
    expect(r.code).toBe(ExitCode.VerifiedPass);
  }, 60_000);
});

describe('5 — a category with no window to measure is a usage error, never a vacuous pass', () => {
  test("knowledgeCheck.failOn ['aged'] without --stale-after → 3; a window or a --fail-on flag makes it well-formed", async () => {
    const root = workspace([entry('k.ok', FILE_REF)], "knowledgeCheck: { failOn: ['aged'] }");
    const r = await run(knowledgeStaleCheckCommand, args(root));
    expect(r.code).toBe(ExitCode.UsageError);
    expect(r.err).toContain("knowledgeCheck.failOn includes 'aged'");
    expect((await run(knowledgeStaleCheckCommand, args(root, [], { 'stale-after': '90d' }))).code).toBe(
      ExitCode.VerifiedPass,
    );
    // A --fail-on flag replaces the config list wholesale.
    expect((await run(knowledgeStaleCheckCommand, args(root, [], { 'fail-on': 'stale' }))).code).toBe(
      ExitCode.VerifiedPass,
    );
  }, 60_000);

  test('--fail-on aged fires only with a window', async () => {
    const root = workspace([entry('k.old', FILE_REF, "verifiedOn: '2020-01-01'")]);
    expect((await run(knowledgeStaleCheckCommand, args(root, [], { 'fail-on': 'aged' }))).code).toBe(
      ExitCode.UsageError,
    );
    const aged = await run(
      knowledgeStaleCheckCommand,
      args(root, [], { 'fail-on': 'aged', 'stale-after': '90d', 'as-of': '2026-09-11' }),
    );
    expect(aged.code).toBe(ExitCode.Failure);
    expect(aged.out).toContain('not verified within 90d');
  }, 60_000);
});

describe('grammar in the new messages', () => {
  test('one malformed reference: "1 reference is MALFORMED … and was never checked"', async () => {
    const root = workspace([entry('k.ok', "[{ kind: 'file', path: 'src/a.ts' }, { kind: 'not-a-kind' }]")]);
    const r = await run(knowledgeStaleCheckCommand, args(root));
    expect(r.code).toBe(ExitCode.NotVerified);
    expect(r.out).toContain('1 reference is MALFORMED (listed above as INVALID) and was never checked');
  }, 60_000);
});
