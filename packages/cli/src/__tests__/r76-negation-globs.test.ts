/**
 * Round 12 (12.2a / 12.2b) — a `!` glob EXCLUDES on every gate plane.
 *
 * Every gate plane used to compile `!src/**\/*.spec.ts` to a literal glob that
 * no path matches and OR it into the list, so the negation was silently
 * ignored: `check wiring` failed on a spec file's export, `policy-lint` on a
 * spec file's TODO, `registry … duplicates` on a spec file's declaration, an
 * extractor ledger drifted on a spec-only id, `generated check` failed a hand
 * file the author carved out, and `docs references check` failed a draft. The
 * decisive A/B: deleting the `!` entries changed NOTHING.
 *
 * Now the same tree, with the negations, exits 0 on every verb — and the A/B
 * below proves each exclusion is load-bearing (without it, each verb fails).
 * Real configs, real handlers, a real pack through the real merge seam.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveProjectConfig } from '@shrkcrft/inspector';
import { clearPackDiscoveryCache } from '@shrkcrft/packs';
import type { ParsedArgs } from '../command-registry.ts';
import { baselineCheckCommand } from '../commands/baseline.command.ts';
import { checkCommand } from '../commands/check.command.ts';
import { docsReferencesCheckCommand } from '../commands/docs-references.command.ts';
import { gatesCheckCommand, gatesCoverageCommand, prepare } from '../commands/gates.command.ts';
import { generatedCheckCommand } from '../commands/generated.command.ts';
import { policyLintCommand } from '../commands/policy-lint.command.ts';
import { registryCommand } from '../commands/registry.command.ts';
import { ExitCode } from '../exit-codes.ts';
import { ruleTouchedBy } from '../gates/gate-rule-globs.ts';

const SLOW = 180_000;

type Handler = { run(a: ParsedArgs): Promise<number> | number };

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

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const LIST = ['src/**/*.ts', '!src/**/*.spec.ts'];

const FILES: Record<string, string> = {
  '.gitignore': '.sharkcraft/\n',
  'src/handlers/a.ts': 'export const A_HANDLER = 1;\n',
  'src/handlers/a.spec.ts': '// TODO spec-only note\nexport const SPEC_HANDLER = 3;\n',
  'src/registry.ts': 'export const HANDLERS = [A_HANDLER];\n',
  'src/ids.ts': "define('alpha');\n",
  'src/ids.spec.ts': "define('alpha');\n",
  'exports.json': `${JSON.stringify(['A_HANDLER', 'HANDLERS'], null, 2)}\n`,
  'gen/a.ts': '// GENERATED — do not edit\nexport const G = 1;\n',
  'gen/b.hand.ts': 'export const HAND = 1;\n',
  'sharkcraft/templates.ts':
    "export default [{ id: 'gmc.handler', name: 'Handler', description: 'A handler construct.', files: [] }];\n",
  'docs/a.md': 'Use `gmc.handler` to add one.\n',
  'docs/drafts/wip.md': 'Soon: `gmc.nonexistent`.\n',
};

function workspace(config: Record<string, unknown>, files: Record<string, string> = FILES): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-neg-'));
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

function git(root: string, ...a: string[]): void {
  const res = spawnSync('git', ['-c', 'user.email=r76@test', '-c', 'user.name=r76', '-c', 'commit.gpgsign=false', ...a], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${a.join(' ')} failed: ${res.stderr ?? ''}`);
}

function committed(root: string): string {
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

interface ISelectors {
  readonly src: readonly string[];
  readonly gen: readonly string[];
  readonly docs: readonly string[];
}

/** One rule on every gate plane, each over the given lists. */
function planes(sel: ISelectors): Record<string, unknown> {
  return {
    projectName: 'fx',
    templateFiles: ['templates.ts'],
    wiringRules: [
      {
        id: 'handlers-registered',
        declared: { files: sel.src, extract: 'export-names', match: '_HANDLER$' },
        registered: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
      },
    ],
    policyRules: [{ id: 'no-todo', surface: 'ts', files: sel.src, pattern: 'TODO', message: 'no todo' }],
    registries: [{ name: 'ids', source: { files: sel.src, extract: 'call-args', anchor: 'define' } }],
    baselines: [
      {
        id: 'exports-ledger',
        baseline: 'exports.json',
        compute: { kind: 'extractor', source: { files: sel.src, extract: 'export-names' } },
      },
    ],
    generatedArtifacts: [{ id: 'gen', generatedGlob: sel.gen, provenanceHeader: { mustMatch: 'GENERATED' } }],
    docReferences: [
      {
        id: 'doc-refs',
        files: sel.docs,
        tokenPattern: '\\bgmc[.-][a-z0-9-]+\\b',
        resolvesAs: ['template'],
        requireContext: 'backtick',
      },
    ],
  };
}

const NEGATED: ISelectors = { src: LIST, gen: ['gen/**/*.ts', '!gen/**/*.hand.ts'], docs: ['docs/**/*.md', '!docs/drafts/**'] };
const WITHOUT_NEGATIONS: ISelectors = { src: ['src/**/*.ts'], gen: ['gen/**/*.ts'], docs: ['docs/**/*.md'] };

const VERBS: readonly (readonly [string, Handler, string[]])[] = [
  ['check wiring', checkCommand, ['wiring']],
  ['policy-lint', policyLintCommand, []],
  ['registry ids duplicates', registryCommand, ['ids', 'duplicates']],
  ['baseline check', baselineCheckCommand, []],
  ['generated check', generatedCheckCommand, []],
  ['docs references check', docsReferencesCheckCommand, []],
  ['gates check', gatesCheckCommand, []],
];

async function exitsOf(root: string): Promise<Record<string, number>> {
  const exits: Record<string, number> = {};
  for (const [name, handler, positional] of VERBS) exits[name] = (await run(handler, args(root, positional))).code;
  return exits;
}

describe('12.2a — a `!` excludes on every gate plane', () => {
  test('every verb exits 0: the spec, hand and draft files the lists exclude are out of scope', async () => {
    const root = workspace(planes(NEGATED));
    expect(await exitsOf(root)).toEqual(Object.fromEntries(VERBS.map(([name]) => [name, ExitCode.VerifiedPass])));
    const gate = JSON.parse((await run(gatesCheckCommand, args(root, [], { json: true }))).out).gate;
    expect(gate.exit).toBe(ExitCode.VerifiedPass);
    for (const r of gate.rules) expect({ id: r.id, status: r.status }).toEqual({ id: r.id, status: 'passed' });
  }, SLOW);

  test('A/B: the same tree WITHOUT the negations fails every one of them — each exclusion is load-bearing', async () => {
    const root = workspace(planes(WITHOUT_NEGATIONS));
    expect(await exitsOf(root)).toEqual(Object.fromEntries(VERBS.map(([name]) => [name, ExitCode.Failure])));
  }, SLOW);

  test('gates coverage: the excluded files are not matched, and each live negation is reported with what it excludes', async () => {
    const root = workspace(planes(NEGATED));
    const body = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true }))).out);
    const rule = (id: string): Record<string, unknown> =>
      body.rules.find((r: { id: string }) => r.id === id) as Record<string, unknown>;
    const wiring = rule('handlers-registered');
    // a.ts, registry.ts, ids.ts — never a.spec.ts or ids.spec.ts.
    expect(wiring['filesMatched']).toBe(3);
    expect(wiring['sampleIds']).toEqual(['A_HANDLER']);
    expect(wiring['negations']).toEqual([{ selector: 'declared: !src/**/*.spec.ts', excludes: 2 }]);
    for (const id of ['no-todo', 'ids', 'exports-ledger']) {
      expect({ id, negations: rule(id)['negations'] }).toEqual({ id, negations: [{ selector: '!src/**/*.spec.ts', excludes: 2 }] });
    }
    expect(rule('gen')['filesMatched']).toBe(1);
    expect(rule('doc-refs')['filesMatched']).toBe(1);
    for (const r of body.rules) expect({ id: r.id, dead: r.deadGlobs }).toEqual({ id: r.id, dead: [] });
    expect(body.deadGlobCount).toBe(0);
    expect(body.gate.exit).toBe(ExitCode.VerifiedPass);

    const text = await run(gatesCoverageCommand, args(root, []));
    expect(text.out).toContain('excludes: declared: !src/**/*.spec.ts (2 files)');
    expect(text.out).toContain('Every rule is connected to something. ✓');
    expect(text.out).not.toContain('⚠');
  }, SLOW);
});

describe('boundary parity — one parser, the plane keeps its EXEMPTION semantics', () => {
  const boundaryFiles = (from: readonly string[]): Record<string, string> => ({
    'sharkcraft/boundaries.ts': `export default [${JSON.stringify({ id: 'src.no-lodash', title: 'no lodash', from, forbiddenImports: ['lodash'] })}];\n`,
    'src/a.spec.ts': "import x from 'lodash';\nexport const a = x;\n",
    'src/b.ts': 'export const b = 1;\n',
  });

  test('the same list on a boundary rule EXEMPTS the spec import: suppressed and counted, exit 0', async () => {
    const root = workspace({ projectName: 'fx', boundaryFiles: ['boundaries.ts'] }, boundaryFiles(LIST));
    const json = JSON.parse((await run(checkCommand, args(root, ['boundaries'], { json: true }))).out);
    expect(json.exitCode).toBe(ExitCode.VerifiedPass);
    expect(json.violations).toEqual([]);
    expect(json.suppressedCounts.exemptFile).toBe(1);
    expect(json.suppressed[0].violation.file).toBe('src/a.spec.ts');
  }, SLOW);

  test('a bare "!" in `from` is a load error naming the entry — never silently dropped', async () => {
    const root = workspace({ projectName: 'fx', boundaryFiles: ['boundaries.ts'] }, boundaryFiles(['src/**', '!']));
    const r = await run(checkCommand, args(root, ['boundaries']));
    // The existing invalid-rule path: an errored rule, never a quiet pass.
    expect(r.code).toBe(ExitCode.Failure);
    expect(r.out).toContain('"!" is not a glob (an empty negation)');
    expect(r.out).toContain('NOT evaluated');
  }, SLOW);
});

describe('--changed-only reads the footprint PER LIST', () => {
  const TWO_RULES = {
    projectName: 'fx',
    wiringRules: [
      {
        id: 'handlers-registered',
        declared: { files: LIST, extract: 'export-names', match: '_HANDLER$' },
        registered: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
      },
      {
        // Its REGISTERED side reads the spec files: the other source's `!`
        // must never hide them from this rule's footprint.
        id: 'spec-mirror',
        severity: 'warning',
        declared: { files: LIST, extract: 'export-names', match: '_HANDLER$' },
        registered: { files: ['src/**/*.spec.ts'], extract: 'export-names', match: '_HANDLER$' },
        registeredExtras: 'allow',
      },
    ],
  };

  test('ruleTouchedBy: a change touching only an excluded file does not select the rule; a rule whose other source reads it is selected', async () => {
    const root = workspace(TWO_RULES);
    const prep = await prepare(args(root, []));
    if (!prep.ok) throw new Error('config did not load');
    const view = (id: string) => prep.value.rules.find((r) => r.id === id)!;
    expect(ruleTouchedBy(view('handlers-registered'), ['src/handlers/a.spec.ts'])).toBe(false);
    expect(ruleTouchedBy(view('handlers-registered'), ['src/handlers/a.ts'])).toBe(true);
    expect(ruleTouchedBy(view('spec-mirror'), ['src/handlers/a.spec.ts'])).toBe(true);
  }, SLOW);

  test('gates check --changed-only over a spec-only change runs only the rule that reads the spec file', async () => {
    const root = committed(workspace(TWO_RULES));
    writeFileSync(join(root, 'src/handlers/a.spec.ts'), '// edited\nexport const SPEC_HANDLER = 3;\n');
    const body = JSON.parse((await run(gatesCheckCommand, args(root, [], { json: true, 'changed-only': true }))).out);
    expect(body.gate.rules.map((r: { id: string }) => r.id)).toEqual(['spec-mirror']);
  }, SLOW);
});

describe('pack-contributed rules — the same scope, and the same shape check at the merge seam', () => {
  function packWorkspace(): string {
    const root = workspace({ projectName: 'fx' });
    const pack = join(root, 'node_modules', '@r76', 'neg-pack');
    mkdirSync(pack, { recursive: true });
    writeFileSync(
      join(pack, 'package.json'),
      JSON.stringify({ name: '@r76/neg-pack', version: '0.0.1', sharkcraft: { manifest: './sharkcraft.plugin.ts' } }),
    );
    writeFileSync(
      join(pack, 'sharkcraft.plugin.ts'),
      "export default { schema: 'sharkcraft.pack/v1', info: { name: '@r76/neg-pack', version: '0.0.1' }, " +
        "contributions: { wiringRuleFiles: ['./wiring.ts'], policyRuleFiles: ['./policy.ts'] } };\n",
    );
    writeFileSync(
      join(pack, 'wiring.ts'),
      `export default ${JSON.stringify([
        {
          id: 'pack-handlers',
          declared: { files: LIST, extract: 'export-names', match: '_HANDLER$' },
          registered: { files: ['src/registry.ts'], extract: 'array-members', anchor: 'HANDLERS' },
        },
      ])};\n`,
    );
    writeFileSync(
      join(pack, 'policy.ts'),
      `export default ${JSON.stringify([
        { id: 'pack-neg-only', surface: 'ts', files: ['!src/**/*.spec.ts'], pattern: 'TODO', message: 'm' },
      ])};\n`,
    );
    return root;
  }

  test('a pack wiring rule with a `!` glob excludes exactly as a local one does', async () => {
    clearPackDiscoveryCache();
    const root = packWorkspace();
    expect((await run(checkCommand, args(root, ['wiring']))).code).toBe(ExitCode.VerifiedPass);
    const cov = JSON.parse((await run(gatesCoverageCommand, args(root, [], { json: true, plane: 'wiring' }))).out);
    const rule = cov.rules.find((r: { id: string }) => r.id === 'pack-handlers');
    expect(rule.negations).toEqual([{ selector: 'declared: !src/**/*.spec.ts', excludes: 2 }]);
    expect(rule.sampleIds).toEqual(['A_HANDLER']);
  }, SLOW);

  test('a pack rule whose list is negation-only is rejected at the merge seam, with the shape message', async () => {
    clearPackDiscoveryCache();
    const root = packWorkspace();
    const resolved = await resolveProjectConfig(root);
    if (!resolved.ok) throw new Error('config did not load');
    expect((resolved.value.config.policyRules ?? []).map((r) => r.id)).not.toContain('pack-neg-only');
    expect(resolved.value.planeDiagnostics.join('\n')).toContain(
      'needs at least one inclusion glob (entries starting with "!" exclude from what the others select)',
    );
  }, SLOW);
});
