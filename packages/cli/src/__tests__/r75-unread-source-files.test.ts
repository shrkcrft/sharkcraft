/**
 * r75 — an UNREADABLE governed source is never "examined", and an EMPTY
 * changeset never widens to the whole tree (round 11 review R11-COV-1 / -8).
 *
 * `scanImports` counted a file as scanned BEFORE reading it and dropped it on
 * a read error, and import hygiene returned `[]` for it. So `chmod 000` on the
 * file holding the violation turned `check boundaries`, `finish` and
 * `diff-check` from 1 into a clean 0 ("examined 1 of 1"), with a false
 * dead-unit "typo?" note on top. The boundary reader now reports unread files
 * and `runBoundaryCheck` folds them through THE unread-file rule
 * (`readScopeCoverage`); hygiene reports its unreadable subjects through
 * `importHygieneCoverage`. Every surface settles 2 and names the file.
 *
 * `check imports --changed-only` over an empty changeset passed `files: []`,
 * which the report read as "no filter" and scanned the whole tree: `[]` now
 * scans nothing and the verb settles 2 (`--allow-empty` → 0).
 *
 * Real temp projects, the real config loader, inspector, command handlers and
 * registered MCP tools. The chmod cases skip where permissions cannot bite
 * (root, Windows).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft } from '@shrkcrft/inspector';
import { ALL_TOOLS } from '@shrkcrft/mcp-server';
import type { ParsedArgs } from '../command-registry.ts';
import { checkCommand } from '../commands/check.command.ts';
import { diffCheckCommand } from '../commands/diff-check.command.ts';
import { finishCommand } from '../commands/finish.command.ts';
import { policyLintCommand } from '../commands/policy-lint.command.ts';
import { ExitCode } from '../exit-codes.ts';

const SLOW = 90_000;
const CANNOT_CHMOD =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

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
  const sink = ((c: string | Uint8Array): boolean => {
    out += typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink as typeof process.stderr.write;
  try {
    return { code: await h.run(a), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const roots: string[] = [];
const locked: string[] = [];
const lockedDirs: string[] = [];
afterAll(() => {
  for (const d of lockedDirs) {
    try {
      chmodSync(d, 0o755);
    } catch {
      // already gone
    }
  }
  for (const f of locked) {
    try {
      chmodSync(f, 0o644);
    } catch {
      // already gone
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-unread-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** `src/app/**` must not import `@scope/ui`; a.ts does, b.ts is clean. */
function boundaryProject(withB = true): string {
  return project({
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n",
    'sharkcraft/boundaries.ts':
      "export default [{ id: 'app.no-ui', title: 'app must not import ui', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/ui'] }];\n",
    'src/app/a.ts': "import { B } from '@scope/ui';\nexport const a = B;\n",
    ...(withB ? { 'src/app/b.ts': 'export const b = 1;\n' } : {}),
  });
}

function lock(root: string, rel: string): void {
  const abs = join(root, rel);
  chmodSync(abs, 0o000);
  locked.push(abs);
}

/** `chmod 000` a DIRECTORY: it can no longer be listed, so nothing beneath it is ever matched. */
function lockDir(root: string, rel: string): void {
  const abs = join(root, rel);
  chmodSync(abs, 0o000);
  lockedDirs.push(abs);
}

const notVerifiedLine = (out: string): string => out.split('\n').find((l) => l.startsWith('NOT VERIFIED:')) ?? '';

function tool(name: string): (typeof ALL_TOOLS)[number] {
  const t = ALL_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`MCP tool ${name} is not registered`);
  return t;
}

interface IRuleRow {
  id: string;
  status: string;
  coverage: { unit: string; expected: number; examined: number; unexamined?: string[] };
}

describe('an unreadable governed source is NOT VERIFIED on every boundary surface (R11-COV-1)', () => {
  test('control: readable, the violation fails `check boundaries` (1)', async () => {
    const root = boundaryProject();
    expect((await run(checkCommand, args(root, ['boundaries']))).code).toBe(ExitCode.Failure);
  }, SLOW);

  test.skipIf(CANNOT_CHMOD)(
    '`check boundaries`: 2 in text and JSON, naming the file — never "no boundary violations", never a dead-unit guess',
    async () => {
      const root = boundaryProject();
      lock(root, 'src/app/a.ts');
      const text = await run(checkCommand, args(root, ['boundaries']));
      expect(text.code).toBe(ExitCode.NotVerified);
      expect(text.out).not.toContain('no boundary violations');
      expect(text.out).not.toContain('typo or retired target');
      expect(notVerifiedLine(text.out)).toContain('src/app/a.ts');

      const json = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out) as {
        exitCode: number;
        gate: { exit: number; rules: IRuleRow[] };
        unreadFiles: { path: string }[];
        deadUnits: unknown[];
      };
      expect({ exitCode: json.exitCode, gate: json.gate.exit }).toEqual({ exitCode: 2, gate: 2 });
      const rule = json.gate.rules.find((r) => r.id === 'app.no-ui');
      expect(rule?.status).toBe('partial');
      expect(rule?.coverage).toMatchObject({ unit: 'files', expected: 2, examined: 1, unexamined: ['src/app/a.ts'] });
      expect(json.unreadFiles.map((u) => u.path)).toEqual(['src/app/a.ts']);
      // "matches no import anywhere … typo?" was a claim made from an incomplete read.
      expect(json.deadUnits).toEqual([]);
    },
    SLOW,
  );

  test.skipIf(CANNOT_CHMOD)(
    'a rule whose ONLY governed file is unreadable is PARTIAL (2) — never "matched nothing" (a failOnEmpty 1)',
    async () => {
      const root = boundaryProject(false);
      lock(root, 'src/app/a.ts');
      const json = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out) as {
        exitCode: number;
        skipped: unknown[];
        gate: { rules: IRuleRow[] };
      };
      expect(json.exitCode).toBe(ExitCode.NotVerified);
      expect(json.skipped).toEqual([]);
      expect(json.gate.rules.find((r) => r.id === 'app.no-ui')).toMatchObject({
        status: 'partial',
        coverage: { unit: 'files', expected: 1, examined: 0, unexamined: ['src/app/a.ts'] },
      });
    },
    SLOW,
  );

  test.skipIf(CANNOT_CHMOD)(
    '`finish --files` and `diff-check --files`: 2 in text and JSON — never "Safe to finish" / "Diff passes"',
    async () => {
      const root = boundaryProject();
      lock(root, 'src/app/a.ts');
      const fin = await run(finishCommand, args(root, [], { files: 'src/app/a.ts' }));
      expect(fin.code).toBe(ExitCode.NotVerified);
      expect(fin.out).not.toContain('Safe to finish');
      const finJson = JSON.parse((await run(finishCommand, args(root, [], { files: 'src/app/a.ts', json: true }))).out) as {
        exitCode: number;
        gates: { name: string; status: string }[];
      };
      expect(finJson.exitCode).toBe(ExitCode.NotVerified);
      const status = Object.fromEntries(finJson.gates.map((g) => [g.name, g.status]));
      expect({ boundaries: status['boundaries'], imports: status['imports'] }).toEqual({
        boundaries: 'partial',
        imports: 'partial',
      });

      const dc = await run(diffCheckCommand, args(root, [], { files: 'src/app/a.ts' }));
      expect(dc.code).toBe(ExitCode.NotVerified);
      expect(dc.out).not.toContain('Diff passes');
      const dcJson = JSON.parse((await run(diffCheckCommand, args(root, [], { files: 'src/app/a.ts', json: true }))).out) as {
        exitCode: number;
        verdict: string;
        gate: { exit: number };
      };
      expect({ exitCode: dcJson.exitCode, verdict: dcJson.verdict, gate: dcJson.gate.exit }).toEqual({
        exitCode: 2,
        verdict: 'not-verified',
        gate: 2,
      });
    },
    SLOW,
  );

  test.skipIf(CANNOT_CHMOD)('`check imports` over an unreadable source: 2 in text and JSON, naming it', async () => {
    const root = boundaryProject();
    lock(root, 'src/app/a.ts');
    const text = await run(checkCommand, args(root, ['imports']));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('Import hygiene (NOT VERIFIED)');
    expect(notVerifiedLine(text.out)).toContain('src/app/a.ts');
    const json = JSON.parse((await run(checkCommand, args(root, ['imports'], { json: true }))).out) as {
      exitCode: number;
      verdict: string;
      unread: string[];
    };
    expect({ exitCode: json.exitCode, verdict: json.verdict, unread: json.unread }).toEqual({
      exitCode: 2,
      verdict: 'not-verified',
      unread: ['src/app/a.ts'],
    });
  }, SLOW);

  test.skipIf(CANNOT_CHMOD)(
    'MCP `check_boundaries` reads THE checked-nothing predicate: its `skipped` / `rulesEvaluated` equal the CLI JSON (R12-REG-1)',
    async () => {
      // The unread-only fixture: the rule's one governed file is unreadable, so
      // it is PARTIAL — never listed as "checked nothing / stale selector".
      const root = boundaryProject(false);
      lock(root, 'src/app/a.ts');
      const cli = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out) as {
        exitCode: number;
        rulesEvaluated: number;
        skipped: unknown[];
      };
      const inspection = await inspectSharkcraft({ cwd: root });
      const mcp = (await tool('check_boundaries').handler({}, { inspection, cwd: root })).data as {
        exitCode: number;
        rulesEvaluated: number;
        skipped: unknown[];
      };
      expect({ exitCode: mcp.exitCode, rulesEvaluated: mcp.rulesEvaluated, skipped: mcp.skipped }).toEqual({
        exitCode: cli.exitCode,
        rulesEvaluated: cli.rulesEvaluated,
        skipped: cli.skipped,
      });
      expect(mcp.skipped).toEqual([]);
      const dc = (await tool('get_diff_check_report').handler({ files: ['src/app/a.ts'] }, { inspection, cwd: root }))
        .data as { boundaries: { rulesEvaluated: number } };
      const dcCli = JSON.parse(
        (await run(diffCheckCommand, args(root, [], { files: 'src/app/a.ts', json: true }))).out,
      ) as { boundaries: { rulesEvaluated: number } };
      expect(dc.boundaries.rulesEvaluated).toBe(dcCli.boundaries.rulesEvaluated);
    },
    SLOW,
  );

  test.skipIf(CANNOT_CHMOD)('MCP `check_boundaries` and `get_diff_check_report` carry the same 2', async () => {
    const root = boundaryProject();
    lock(root, 'src/app/a.ts');
    const inspection = await inspectSharkcraft({ cwd: root });
    const cb = (await tool('check_boundaries').handler({}, { inspection, cwd: root })).data as {
      verdict: string;
      exitCode: number;
    };
    expect({ verdict: cb.verdict, exitCode: cb.exitCode }).toEqual({ verdict: 'not-verified', exitCode: 2 });
    const dc = (await tool('get_diff_check_report').handler({ files: ['src/app/a.ts'] }, { inspection, cwd: root }))
      .data as { verdict: string; exitCode: number };
    expect({ verdict: dc.verdict, exitCode: dc.exitCode }).toEqual({ verdict: 'not-verified', exitCode: 2 });
  }, SLOW);
});

describe('an UNLISTABLE directory is never a clean 0 — its files were never even matched (R12-GAP-1)', () => {
  /**
   * `src/app/**` must not import `@scope/ui` — the violation sits one level
   * down, in src/app/sub/a.ts; b.ts is clean. `app.top.no-db` governs only
   * `src/app/*.ts`, so no glob of it can reach beneath src/app/sub/. The policy
   * rule reads the shared reader (`readMatchingFiles`).
   */
  function nestedProject(): string {
    return project({
      'package.json': JSON.stringify({ name: 'fx', version: '0.0.0', dependencies: { '@scope/db': '1.0.0' } }),
      'sharkcraft/sharkcraft.config.ts':
        "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'], policyRules: [{ id: 'no-forbidden', surface: 'ts', files: ['src/**/*.ts'], pattern: 'FORBIDDEN_TOKEN', message: 'remove it', severity: 'error' }] };\n",
      'sharkcraft/boundaries.ts':
        "export default [{ id: 'app.no-ui', title: 'app must not import ui', severity: 'error', from: ['src/app/**'], forbiddenImports: ['@scope/ui'] }, { id: 'app.top.no-db', title: 'top-level app files must not import db', severity: 'error', from: ['src/app/*.ts'], forbiddenImports: ['@scope/db'] }];\n",
      'src/app/sub/a.ts': "import { B } from '@scope/ui';\nexport const FORBIDDEN_TOKEN = B;\n",
      'src/app/b.ts': 'export const b = 1;\n',
    });
  }

  interface IBoundaryJson {
    exitCode: number;
    verdict: string;
    rulesEvaluated: number;
    skipped: unknown[];
    unreadFiles: { path: string; reason: string }[];
    gate: { exit: number; rules: IRuleRow[] };
  }

  test('control: readable, the nested violation fails `check boundaries` and `policy-lint` (1)', async () => {
    const root = nestedProject();
    expect((await run(checkCommand, args(root, ['boundaries']))).code).toBe(ExitCode.Failure);
    expect((await run(policyLintCommand, args(root, []))).code).toBe(ExitCode.Failure);
  }, SLOW);

  test.skipIf(CANNOT_CHMOD)(
    '`check boundaries`: 2 in text and JSON, the directory named — a rule that cannot reach beneath it is untouched; MCP agrees',
    async () => {
      const root = nestedProject();
      lockDir(root, 'src/app/sub');
      const text = await run(checkCommand, args(root, ['boundaries']));
      expect(text.code).toBe(ExitCode.NotVerified);
      expect(text.out).not.toContain('no boundary violations');
      expect(notVerifiedLine(text.out)).toContain('src/app/sub/');

      const json = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out) as IBoundaryJson;
      expect({ exitCode: json.exitCode, gate: json.gate.exit, verdict: json.verdict }).toEqual({
        exitCode: 2,
        gate: 2,
        verdict: 'not-verified',
      });
      expect(json.unreadFiles).toEqual([{ path: 'src/app/sub/', reason: 'unreadable-directory' }]);
      expect(json.gate.rules.find((r) => r.id === 'app.no-ui')).toMatchObject({
        status: 'partial',
        coverage: { unit: 'files', expected: 2, examined: 1, unexamined: ['src/app/sub/'] },
      });
      expect(json.gate.rules.find((r) => r.id === 'app.top.no-db')?.status).toBe('passed');

      const inspection = await inspectSharkcraft({ cwd: root });
      const mcp = (await tool('check_boundaries').handler({}, { inspection, cwd: root })).data as IBoundaryJson;
      expect({ exitCode: mcp.exitCode, rulesEvaluated: mcp.rulesEvaluated, skipped: mcp.skipped }).toEqual({
        exitCode: json.exitCode,
        rulesEvaluated: json.rulesEvaluated,
        skipped: json.skipped,
      });
    },
    SLOW,
  );

  test.skipIf(CANNOT_CHMOD)('`check imports` and `policy-lint` over an unlistable directory: 2, naming it', async () => {
    const root = nestedProject();
    expect((await run(checkCommand, args(root, ['imports']))).code).toBe(ExitCode.VerifiedPass);
    lockDir(root, 'src/app/sub');
    const imports = JSON.parse((await run(checkCommand, args(root, ['imports'], { json: true }))).out) as {
      exitCode: number;
      unread: string[];
    };
    expect({ exitCode: imports.exitCode, unread: imports.unread }).toEqual({ exitCode: 2, unread: ['src/app/sub/'] });
    const policy = await run(policyLintCommand, args(root, []));
    expect(policy.code).toBe(ExitCode.NotVerified);
    expect(notVerifiedLine(policy.out)).toContain('src/app/sub/');
  }, SLOW);

  test.skipIf(CANNOT_CHMOD)(
    '`finish --files` a file beneath the unlistable directory: boundaries + imports partial, exit 2 — never "Safe to finish"',
    async () => {
      const root = nestedProject();
      lockDir(root, 'src/app/sub');
      const fin = JSON.parse(
        (await run(finishCommand, args(root, [], { files: 'src/app/sub/a.ts', json: true }))).out,
      ) as { exitCode: number; gates: { name: string; status: string }[] };
      expect(fin.exitCode).toBe(ExitCode.NotVerified);
      const status = Object.fromEntries(fin.gates.map((g) => [g.name, g.status]));
      expect({ boundaries: status['boundaries'], imports: status['imports'] }).toEqual({
        boundaries: 'partial',
        imports: 'partial',
      });
    },
    SLOW,
  );
});

describe('`check imports --changed-only` over an EMPTY changeset never widens to the tree (R11-COV-8)', () => {
  /** Not a git repo: the changeset is empty. b.ts holds findings the WHOLE-TREE scan would report. */
  function emptyChangeset(): string {
    return project({
      'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
      'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
      'src/a.ts': 'export const A = 1;\n',
      'src/b.ts': "export async function f(): Promise<unknown> { await import('./a.ts'); return require('./a.ts'); }\n",
    });
  }

  test('2 in text and JSON with no findings from untouched files; --allow-empty accepts it (0)', async () => {
    const root = emptyChangeset();
    // Control: the whole tree has the findings.
    expect((await run(checkCommand, args(root, ['imports']))).code).toBe(ExitCode.Failure);

    const text = await run(checkCommand, args(root, ['imports'], { 'changed-only': true }));
    expect(text.code).toBe(ExitCode.NotVerified);
    expect(text.out).toContain('NOT VERIFIED');
    expect(text.out).toContain('--allow-empty');
    expect(text.out).not.toContain('src/b.ts');

    const json = JSON.parse((await run(checkCommand, args(root, ['imports'], { 'changed-only': true, json: true }))).out) as {
      exitCode: number;
      verdict: string;
      findings: unknown[];
      filesInScope: number;
    };
    expect({ exitCode: json.exitCode, verdict: json.verdict, findings: json.findings.length, inScope: json.filesInScope }).toEqual({
      exitCode: 2,
      verdict: 'not-verified',
      findings: 0,
      inScope: 0,
    });

    const accepted = await run(checkCommand, args(root, ['imports'], { 'changed-only': true, 'allow-empty': true }));
    expect(accepted.code).toBe(ExitCode.VerifiedPass);
  }, SLOW);
});
