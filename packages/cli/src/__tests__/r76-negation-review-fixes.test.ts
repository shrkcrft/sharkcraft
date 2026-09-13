/**
 * Round 12 (12.2 review) — the negation call sites the first pass missed.
 *
 * 1. `generated update` placed a FIRST-generation file by the literal directory
 *    of every `generatedGlob` entry, the negation's `!gen` included, so the
 *    target was ambiguous: the file was refused as "outside generatedGlob"
 *    (exit 1) although `gen/x.ts` is inside it. A raw-list consumer the
 *    `matchesAny(` grep lock cannot see.
 * 2. `gates coverage` never judged the generated or doc-reference plane's globs
 *    (`deadGlobs: []`, `globsChecked: 0`): a live `!` was never printed and a
 *    dead one never reported — while the docs said every live one is printed.
 * 3. A rule its own negations emptied read "the selector is probably stale".
 *
 * Real configs on disk: the CLI spawned from source, and the real handlers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectSharkcraft, type IQualityConfig } from '@shrkcrft/inspector';
import type { ParsedArgs } from '../command-registry.ts';
import { gatesCoverageCommand, prepare } from '../commands/gates.command.ts';
import { policyLintCommand } from '../commands/policy-lint.command.ts';
import { ExitCode } from '../exit-codes.ts';
import { runQuality } from '../quality/run-quality.ts';

const SLOW = 180_000;
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts');

type Handler = { run(a: ParsedArgs): Promise<number> | number };

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(config: Record<string, unknown>, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-negfix-'));
  roots.push(root);
  mkdirSync(join(root, 'sharkcraft'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  writeFileSync(join(root, 'sharkcraft', 'sharkcraft.config.ts'), `export default ${JSON.stringify(config, null, 2)};\n`);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function shrk(root: string, argv: readonly string[]): { status: number; stdout: string } {
  const res = spawnSync('bun', ['run', CLI_MAIN, '--cwd', root, ...argv], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: res.status ?? -1, stdout: String(res.stdout ?? '') };
}

function args(root: string, positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return {
    positional,
    flags: new Map<string, string | boolean>([['cwd', root], ...Object.entries(flags)]),
    multiFlags: new Map(),
  };
}

async function run(h: Handler, a: ParsedArgs): Promise<{ code: number; out: string }> {
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

type Row = Record<string, unknown> & { id: string };
const rowOf = (body: { rules: Row[] }, id: string): Row => body.rules.find((r) => r.id === id)!;

describe('generated update — a first generation is placed by the inclusion globs only', () => {
  const HAND = 'export const HAND = 1;\n';
  /** The regen emits ONE flat file; nothing it produces is committed yet. */
  function genRepo(generatedGlob: readonly string[], files: Record<string, string>): string {
    return workspace(
      {
        projectName: 'fx',
        generatedArtifacts: [
          { id: 'gen', generatedGlob, regen: "mkdir -p {TMP} && echo 'export const X = 1;' > {TMP}/x.ts" },
        ],
      },
      files,
    );
  }

  test('with a `!` entry: placed at gen/x.ts, exit 0, and `generated check` then agrees', () => {
    const root = genRepo(['gen/**/*.ts', '!gen/**/*.hand.ts'], { 'gen/b.hand.ts': HAND });
    const res = shrk(root, ['generated', 'update', '--id', 'gen', '--json']);
    const out = JSON.parse(res.stdout) as { results: { created: string[]; notPlaced: string[]; noLongerProduced: string[] }[] };
    expect({ status: res.status, created: out.results[0]!.created, notPlaced: out.results[0]!.notPlaced }).toEqual({
      status: ExitCode.VerifiedPass,
      created: ['gen/x.ts'],
      notPlaced: [],
    });
    // The hand file the list carves out is out of the bless entirely.
    expect(out.results[0]!.noLongerProduced).toEqual([]);
    expect(readFileSync(join(root, 'gen', 'x.ts'), 'utf8')).toBe('export const X = 1;\n');
    expect(readFileSync(join(root, 'gen', 'b.hand.ts'), 'utf8')).toBe(HAND);
    expect(existsSync(join(root, 'x.ts'))).toBe(false);
    expect(shrk(root, ['generated', 'check', '--id', 'gen']).status).toBe(ExitCode.VerifiedPass);
  }, SLOW);

  test('A/B control: the negation-free list places the same file the same way', () => {
    const root = genRepo(['gen/**/*.ts'], {});
    const res = shrk(root, ['generated', 'update', '--id', 'gen']);
    expect(res.status).toBe(ExitCode.VerifiedPass);
    expect(res.stdout).toContain('+ gen/x.ts');
    expect(res.stdout).not.toContain('not written');
  }, SLOW);

  test('A/B: without the `!`, the hand file is in the rule — the regen stops producing it, so the bless is incomplete', () => {
    const root = genRepo(['gen/**/*.ts'], { 'gen/b.hand.ts': HAND });
    const res = shrk(root, ['generated', 'update', '--id', 'gen', '--json']);
    const out = JSON.parse(res.stdout) as { results: { noLongerProduced: string[] }[] };
    expect(res.status).toBe(ExitCode.Failure);
    expect(out.results[0]!.noLongerProduced).toEqual(['gen/b.hand.ts']);
  }, SLOW);
});

describe('gates coverage judges the generated and doc-reference planes like every other plane', () => {
  const FILES: Record<string, string> = {
    'gen/a.ts': '// GENERATED — do not edit\nexport const G = 1;\n',
    'gen/b.hand.ts': 'export const HAND = 1;\n',
    'docs/a.md': 'Use `gmc.handler` to add one.\n',
    'docs/drafts/wip.md': 'Soon: `gmc.nonexistent`.\n',
    'sharkcraft/templates.ts':
      "export default [{ id: 'gmc.handler', name: 'Handler', description: 'A handler construct.', files: [] }];\n",
  };
  const docRule = (id: string, files: readonly string[]): Record<string, unknown> => ({
    id,
    files,
    tokenPattern: '\\bgmc[.-][a-z0-9-]+\\b',
    resolvesAs: ['template'],
    requireContext: 'backtick',
    severity: 'warning',
  });
  const CONFIG = {
    projectName: 'fx',
    templateFiles: ['templates.ts'],
    generatedArtifacts: [
      { id: 'gen', generatedGlob: ['gen/**/*.ts', '!gen/**/*.hand.ts'], provenanceHeader: { mustMatch: 'GENERATED' } },
      // The typo'd negation: it excludes nothing, so it is dead.
      { id: 'gen-typo', generatedGlob: ['gen/**/*.ts', '!gen/nowhere/**'], provenanceHeader: { mustMatch: '.' } },
    ],
    docReferences: [docRule('doc-refs', ['docs/**/*.md', '!docs/drafts/**']), docRule('doc-typo', ['docs/**/*.md', '!docs/draft/**'])],
  };
  const deadNegation = (glob: string): Record<string, unknown> => ({
    selector: glob,
    glob,
    negation: true,
    reason: 'excludes nothing — none of the 2 file(s) the other globs select match it',
  });

  test('a live negation is reported with what it excludes; a dead one is a dead unit with its reason', async () => {
    const root = workspace(CONFIG, FILES);
    const body = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    const units = (id: string) => {
      const r = rowOf(body, id);
      return { negations: r['negations'], dead: r['deadGlobUnits'], checked: r['globsChecked'] };
    };
    expect(units('gen')).toEqual({ negations: [{ selector: '!gen/**/*.hand.ts', excludes: 1 }], dead: [], checked: 2 });
    expect(units('doc-refs')).toEqual({ negations: [{ selector: '!docs/drafts/**', excludes: 1 }], dead: [], checked: 2 });
    expect(units('gen-typo')).toEqual({ negations: [], dead: [deadNegation('!gen/nowhere/**')], checked: 2 });
    expect(units('doc-typo')).toEqual({ negations: [], dead: [deadNegation('!docs/draft/**')], checked: 2 });
    expect(body.deadGlobCount).toBe(2);
    // Advisory: the exit is unchanged.
    expect(body.gate.exit).toBe(ExitCode.VerifiedPass);

    const text = await run(gatesCoverageCommand, args(root, []));
    expect(text.code).toBe(ExitCode.VerifiedPass);
    expect(text.out).toContain('excludes: !gen/**/*.hand.ts (1 file)');
    expect(text.out).toContain('excludes: !docs/drafts/** (1 file)');
    expect(text.out).toContain(
      '⚠ 1 of 2 glob(s) dead: !docs/draft/** (excludes nothing — none of the 2 file(s) the other globs select match it)',
    );
  }, SLOW);

  test('--fail-on-dead-units fails on those two dead units, and only on them', async () => {
    const root = workspace(CONFIG, FILES);
    const body = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true, 'fail-on-dead-units': true }))).out);
    expect(body.gate.exit).toBe(ExitCode.Failure);
    const failing = (body.gate.rules as { id: string; status: string; violations: { id: string }[] }[])
      .filter((r) => r.status === 'failed')
      .map((r) => ({ id: r.id, units: r.violations.map((v) => v.id) }));
    expect(failing).toEqual([
      { id: 'gen-typo', units: ['!gen/nowhere/**'] },
      { id: 'doc-typo', units: ['!docs/draft/**'] },
    ]);
  }, SLOW);
});

describe('a rule its own negations emptied is not called a stale selector', () => {
  const FILES: Record<string, string> = {
    'src/handlers/a.ts': 'export const A_HANDLER = 1;\n',
    'src/handlers/a.spec.ts': '// TODO spec note\nexport const SPEC_HANDLER = 1;\n',
    'src/registry.ts': 'export const HANDLERS = [A_HANDLER];\n',
  };
  const EMPTIED = ['src/handlers/*.spec.ts', '!**/*.spec.ts'];
  const CAUSE = 'every file its inclusion globs select is excluded';

  test('gates coverage: the emptied rows name the negations that did it; a truly stale one keeps "probably stale"', async () => {
    const root = workspace(
      {
        projectName: 'fx',
        policyRules: [
          { id: 'emptied-policy', surface: 'ts', files: EMPTIED, pattern: 'TODO', message: 'm' },
          { id: 'stale-policy', surface: 'ts', files: ['nowhere/*.ts'], pattern: 'TODO', message: 'm', severity: 'warning' },
        ],
        wiringRules: [
          {
            id: 'emptied-wiring',
            declared: { files: EMPTIED, extract: 'export-names', match: '_HANDLER$' },
            registered: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
          },
          {
            // Guard: its list HAS a live negation, but a surviving file yields
            // no id — that zero is the extractor's, not the negation's.
            id: 'no-ids-wiring',
            severity: 'warning',
            declared: { files: ['src/**/*.ts', '!src/**/*.spec.ts'], extract: 'export-names', match: '^NOPE$' },
            registered: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
          },
        ],
      },
      FILES,
    );
    const body = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    expect(rowOf(body, 'emptied-policy')['excludedByNegations']).toEqual([{ selector: '!**/*.spec.ts', excludes: 1 }]);
    expect(rowOf(body, 'emptied-wiring')['excludedByNegations']).toEqual([
      { selector: 'declared: !**/*.spec.ts', excludes: 1 },
    ]);
    for (const id of ['stale-policy', 'no-ids-wiring']) {
      expect({ id, status: rowOf(body, id)['status'], by: rowOf(body, id)['excludedByNegations'] }).toEqual({
        id,
        status: 'empty',
        by: undefined,
      });
    }
    const gateRule = (id: string) => (body.gate.rules as { id: string; skipReason?: string }[]).find((r) => r.id === id)!;
    expect(gateRule('emptied-policy').skipReason).toBe(
      'matched 0 content units — its own negations exclude every file its inclusion globs select',
    );
    expect(gateRule('stale-policy').skipReason).toBe('matched 0 content units');
    // Exits unchanged: the error-severity emptied rules fail on empty (1).
    expect(body.gate.exit).toBe(ExitCode.Failure);

    const text = await run(gatesCoverageCommand, args(root, []));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain(`FAILED — matched nothing after its own negations: ${CAUSE} (!**/*.spec.ts (1 file))`);
    expect(text.out).toContain(`FAILED — matched nothing after its own negations: ${CAUSE} (declared: !**/*.spec.ts (1 file))`);
    expect(text.out).toContain('← 2 stale selector suspect(s), 2 emptied by their own negations');
    // The stale control and the no-ids guard keep the stale diagnosis.
    expect(text.out.match(/SKIPPED — matched nothing; the selector is probably stale/g)?.length).toBe(2);
  }, SLOW);

  test('policy-lint says the same in its skip reason — text and --json, exit unchanged', async () => {
    const root = workspace(
      { projectName: 'fx', policyRules: [{ id: 'emptied-policy', surface: 'ts', files: EMPTIED, pattern: 'TODO', message: 'm' }] },
      FILES,
    );
    const reason = `0 content units: ${CAUSE} by its own negations (!**/*.spec.ts (1 file))`;
    const text = await run(policyLintCommand, args(root, []));
    expect(text.code).toBe(ExitCode.Failure);
    expect(text.out).toContain(`emptied-policy: ${reason}`);
    const json = JSON.parse((await run(policyLintCommand, args(root, [], { json: true }))).out);
    expect(json.skipped.map((s: { ruleId: string; reason: string }) => ({ id: s.ruleId, reason: s.reason }))).toEqual([
      { id: 'emptied-policy', reason },
    ]);
    const rule = json.rules.find((r: { ruleId: string }) => r.ruleId === 'emptied-policy');
    expect(rule.excludedByNegations).toEqual([{ glob: '!**/*.spec.ts', excludes: 1 }]);
  }, SLOW);

  test('shrk quality: a soft-empty emptied rule gets no "probably stale" note', async () => {
    const root = workspace(
      {
        projectName: 'fx',
        policyRules: [
          { id: 'emptied-policy', surface: 'ts', files: EMPTIED, pattern: 'TODO', message: 'm', severity: 'warning' },
        ],
      },
      FILES,
    );
    const prep = await prepare(args(root, []));
    if (!prep.ok) throw new Error('config did not load');
    const result = await runQuality({
      inspection: await inspectSharkcraft({ cwd: root }),
      config: {} as IQualityConfig,
      strict: false,
      failFast: false,
      cwd: root,
      excludeDirs: prep.value.excludeDirs,
      gateRules: prep.value.rules,
    });
    const notes = result.items.find((i) => i.id === 'gates-coverage')?.notes.join('\n') ?? '';
    expect(notes).toContain(
      '[policy] emptied-policy — matched 0 content units — its own negations exclude every file its inclusion globs select',
    );
    expect(notes).not.toContain('probably stale');
  }, SLOW);
});
