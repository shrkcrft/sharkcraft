/**
 * r77 — `expectEmpty` on the gate planes (round 13, lane G; DECISIONS §4–§6,
 * DESIGN-D1 "perPlane" and tests item 6).
 *
 * Every data-defined gate plane can be told that an empty result is the
 * INTENDED one, per unit: `{ pattern, expectEmpty: true }` in a markable list.
 * One core authority settles it (`settleUnitLiveness` / `settleRuleEmptiness`),
 * so the plane verb, `gates check` and `gates coverage` agree on state and
 * exit by construction. This file drives the REAL loader and the CLI from
 * source over real temp workspaces (the V2 f2a–f2e analogues), and pins the
 * behaviour changes the round makes:
 *
 *   - a planned glob on each plane: the plane verb, `gates check` and `gates
 *     coverage` all exit 0 and print `accepted by expectEmpty` (was 1 / 2);
 *   - a marked dead negation is accepted; a marker whose target appears reads
 *     went-live (✓ withheld, exit unchanged) and `--fail-on-dead-units` fails it;
 *   - a baseline FENCE over a dead input is no longer accepted (V2 f1d: 0 → 1);
 *   - a CEILING over an empty extractor is a loud skip on every verb (V2 f1h,
 *     P1: `baseline check` / `gates check` printed ✓ while coverage failed);
 *     `expectEmpty` on a ceiling stays legal and is honoured;
 *   - the text renderers print `FAILED — <reason>`, never DRIFT with a bless
 *     hint; the list verbs report the EFFECTIVE failOnEmpty; ONE advice string;
 *   - `gates try` text prints the dead globs its JSON reports; the import-edges
 *     barrel hint is never printed over a verified fence.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { EMPTY_RULE_ADVICE } from '@shrkcrft/core';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_MAIN = join(REPO_ROOT, 'packages', 'cli', 'src', 'main.ts');

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A real workspace: `package.json` plus the given files. */
function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-gate-ee-'));
  roots.push(root);
  const all: Record<string, string> = { 'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }), ...files };
  for (const [rel, body] of Object.entries(all)) write(root, rel, body);
  return root;
}

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

interface IRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** The CLI FROM SOURCE (the global `shrk` is stale). */
function shrk(root: string, argv: readonly string[]): IRun {
  const r = spawnSync('bun', [CLI_MAIN, '--no-hints', '--cwd', root, ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

interface IGateJson {
  readonly gate: {
    readonly exit: number;
    readonly accepted: readonly string[];
    readonly rules: readonly {
      readonly id: string;
      readonly status: string;
      readonly coverage: { readonly acceptedBy?: string };
      readonly unitAcceptance?: { readonly acceptedBy?: string };
    }[];
  };
  readonly rules?: readonly {
    readonly id: string;
    readonly status: string;
    readonly emptiness?: string;
    readonly hint?: string;
    readonly units?: { readonly intendedEmpty: readonly string[]; readonly wentLive: readonly string[]; readonly dead: readonly string[] };
  }[];
}

function json(root: string, argv: readonly string[]): { readonly code: number; readonly body: IGateJson } {
  const r = shrk(root, [...argv, '--json']);
  return { code: r.code, body: JSON.parse(r.out) as IGateJson };
}

const cfg = (planes: string): string => `export default { projectName: 'fx', ${planes} };\n`;
const NOTHING = 'export const nothing = 1;\n';

/**
 * The V2 f2a–f2e analogues: one planned selector per plane, each a
 * correct-but-unsayable configuration before round 13.
 */
const PLANES: readonly {
  readonly plane: string;
  readonly verb: readonly string[];
  readonly rule: string;
  readonly files: Readonly<Record<string, string>>;
}[] = [
  {
    plane: 'policy (f2a: forbid react in a planned src/ui)',
    verb: ['policy-lint'],
    rule: 'no-react-in-ui',
    files: {
      'src/core/a.ts': NOTHING,
      'sharkcraft/sharkcraft.config.ts': cfg(
        "policyRules: [{ id: 'no-react-in-ui', surface: 'ts', pattern: 'react', message: 'no react', files: [{ pattern: 'src/ui/**/*.ts', expectEmpty: true, reason: 'the ui package lands in Q3' }] }]",
      ),
    },
  },
  {
    plane: 'wiring (f2b: a planned declared side)',
    verb: ['check', 'wiring'],
    rule: 'plugins-registered',
    files: {
      'src/registry.ts': "export const REGISTERED = ['A'];\n",
      'sharkcraft/sharkcraft.config.ts': cfg(
        "wiringRules: [{ id: 'plugins-registered', declared: { files: [{ pattern: 'src/plugins/**/*.ts', expectEmpty: true }], pattern: 'export const ([A-Z]+)_PLUGIN' }, registered: { files: ['src/registry.ts'], arrayProperty: 'REGISTERED' } }]",
      ),
    },
  },
  {
    plane: 'registry (f2c: an inventory over a planned directory)',
    verb: ['gates', 'check'],
    rule: 'commands',
    files: {
      'src/app.ts': NOTHING,
      'sharkcraft/sharkcraft.config.ts': cfg(
        "registries: [{ name: 'commands', source: { files: [{ pattern: 'src/commands/**/*.ts', expectEmpty: true }], pattern: \"name: '([a-z]+)'\" } }]",
      ),
    },
  },
  {
    plane: 'registration (f2c: a planned declared role)',
    verb: ['gates', 'check'],
    rule: 'planned-tokens',
    files: {
      'src/app.ts': 'provide(T1);\ninject(T1);\n',
      'sharkcraft/sharkcraft.config.ts': cfg(
        "registrationGraph: [{ name: 'planned-tokens', declared: { files: [{ pattern: 'src/planned/tokens.ts', expectEmpty: true }], pattern: 'export const ([A-Z0-9]+) = token' }, provided: { files: ['src/app.ts'], pattern: 'provide[(]([A-Z0-9]+)[)]' }, consumed: { files: ['src/app.ts'], pattern: 'inject[(]([A-Z0-9]+)[)]' } }]",
      ),
    },
  },
  {
    plane: 'baseline (a ledger over a planned source)',
    verb: ['baseline', 'check'],
    rule: 'planned-source',
    files: {
      'baselines/planned.json': '[]\n',
      'sharkcraft/sharkcraft.config.ts': cfg(
        "baselines: [{ id: 'planned-source', baseline: 'baselines/planned.json', compute: { kind: 'extractor', source: { files: [{ pattern: 'appP/**/*.ts', expectEmpty: true }], extract: 'export-names' } } }]",
      ),
    },
  },
  {
    plane: 'generated (f2d: a header-only rule over a planned tree)',
    verb: ['generated', 'check'],
    rule: 'gen-planned',
    files: {
      'src/a.ts': NOTHING,
      'sharkcraft/sharkcraft.config.ts': cfg(
        "generatedArtifacts: [{ id: 'gen-planned', generatedGlob: [{ pattern: 'src/generated/**', expectEmpty: true }], provenanceHeader: { mustMatch: 'GENERATED' } }]",
      ),
    },
  },
  {
    plane: 'doc references (f2e: a rule over planned docs/adr)',
    verb: ['docs', 'references', 'check'],
    rule: 'adr-refs',
    files: {
      'docs/guide.md': '# Guide\n',
      'sharkcraft/sharkcraft.config.ts': cfg(
        "docReferences: [{ id: 'adr-refs', files: [{ pattern: 'docs/adr/**/*.md', expectEmpty: true }], tokenPattern: 'shrk [a-z]+', resolvesAs: ['command'] }]",
      ),
    },
  },
];

describe('a planned selector on every plane — the plane verb, gates check and gates coverage agree', () => {
  for (const p of PLANES) {
    test(
      p.plane,
      () => {
        const root = fixture(p.files);
        const verb = json(root, p.verb);
        const check = json(root, ['gates', 'check']);
        const coverage = json(root, ['gates', 'coverage']);
        // One state, one exit, on every surface: the rule is INTENDED-empty,
        // accepted (0) — before round 13 it was 1 (failOnEmpty) or 2.
        expect([verb.code, check.code, coverage.code]).toEqual([0, 0, 0]);
        for (const env of [verb.body.gate, check.body.gate, coverage.body.gate]) {
          expect(env.exit).toBe(0);
          expect(env.accepted.join('\n')).toContain(`${p.rule}: accepted by expectEmpty`);
        }
        expect(coverage.body.rules?.find((r) => r.id === p.rule)).toMatchObject({ status: 'ok', emptiness: 'intended-empty' });
        // The acceptance rides on the envelope rule: AS its coverage when every
        // judged unit is intended-empty, beside it (`unitAcceptance`) when the
        // rule also judged live units (a registration idiom's live roles).
        const envRule = check.body.gate.rules.find((r) => r.id === p.rule);
        expect(envRule?.unitAcceptance?.acceptedBy ?? envRule?.coverage.acceptedBy).toBe('expectEmpty');
      },
      60_000,
    );
  }
});

describe('unit states', () => {
  const POLICY = cfg(
    "policyRules: [{ id: 'no-debugger', surface: 'ts', pattern: 'debugger', message: 'no debugger', files: ['src/core/**/*.ts', { pattern: 'src/plugins/**/*.ts', expectEmpty: true }, { pattern: '!src/**/*.generated.ts', expectEmpty: true }] }]",
  );

  test(
    'a marked dead NEGATION and a marked planned sibling are accepted inside a connected rule',
    () => {
      const root = fixture({ 'src/core/a.ts': NOTHING, 'sharkcraft/sharkcraft.config.ts': POLICY });
      const cov = json(root, ['gates', 'coverage']);
      expect(cov.code).toBe(0);
      const row = cov.body.rules?.find((r) => r.id === 'no-debugger');
      expect(row?.status).toBe('ok');
      expect(row?.units?.dead).toEqual([]);
      expect(row?.units?.intendedEmpty.join('\n')).toContain('!src/**/*.generated.ts');
      expect(row?.units?.intendedEmpty.join('\n')).toContain('src/plugins/**/*.ts');
      // `--fail-on-dead-units` is SAFE to enable: an intended-empty unit never fails.
      expect(shrk(root, ['gates', 'coverage', '--fail-on-dead-units']).code).toBe(0);
    },
    60_000,
  );

  test(
    'a marker whose target appears went live: ⚠ and no ✓ (exit unchanged); --fail-on-dead-units fails it',
    () => {
      const root = fixture({
        'src/core/a.ts': NOTHING,
        'src/plugins/y.ts': NOTHING,
        'src/core/x.generated.ts': NOTHING,
        'sharkcraft/sharkcraft.config.ts': POLICY,
      });
      const text = shrk(root, ['gates', 'coverage']);
      expect(text.code).toBe(0);
      expect(text.out).toContain('expectEmpty is stale: it now matches 1 file — the fence went live; remove expectEmpty');
      expect(text.out).toContain('expectEmpty is stale: it now excludes 1 file');
      expect(text.out).not.toContain('Every rule is connected to something. ✓');
      const failed = shrk(root, ['gates', 'coverage', '--fail-on-dead-units']);
      expect(failed.code).toBe(1);
      expect(failed.out).toContain('--fail-on-dead-units is set — FAILED');
    },
    60_000,
  );

  test(
    'an UNMARKED dead glob still reads dead — with the one wording that names the third cause',
    () => {
      const root = fixture({
        'src/core/a.ts': NOTHING,
        'sharkcraft/sharkcraft.config.ts': cfg(
          "policyRules: [{ id: 'p', surface: 'ts', pattern: 'debugger', message: 'm', files: ['src/core/**/*.ts', 'src/plugins/**/*.ts'] }]",
        ),
      });
      const cov = json(root, ['gates', 'coverage']);
      expect(cov.body.rules?.find((r) => r.id === 'p')?.units?.dead.join('\n')).toContain('src/plugins/**/*.ts');
      expect(shrk(root, ['gates', 'coverage', '--fail-on-dead-units']).code).toBe(1);
    },
    60_000,
  );
});

describe('baselines — the fence, the ceiling (P1) and the renderers', () => {
  const FENCE = (source: string): string =>
    cfg(
      `baselines: [{ id: 'fence', baseline: 'baselines/fence.json', direction: 'additions-only', expectEmpty: true, compute: { kind: 'extractor', source: { files: ['${source}'], extract: 'import-edges', to: { files: ['appB/**'] } } } }]`,
    );
  const APPS = { 'appA/a.ts': 'export const a = 1;\n', 'appB/b.ts': 'export const b = 2;\n', 'baselines/fence.json': '[]\n' };

  test(
    'a fence over LIVE inputs is still the asserted pass, worded one way, with no barrel hint',
    () => {
      const root = fixture({ ...APPS, 'sharkcraft/sharkcraft.config.ts': FENCE('appA/**/*.ts') });
      for (const argv of [['baseline', 'check'], ['gates', 'check'], ['gates', 'coverage']]) {
        const r = json(root, argv);
        expect({ argv, code: r.code }).toEqual({ argv, code: 0 });
        expect(r.body.gate.accepted.join('\n')).toContain('fence: accepted by expectEmpty: true: 0 entries to examine — the rule asserts an empty set');
      }
      // The verified fence is not sent to "fix" its `to.files` (the barrel hint).
      const coverage = shrk(root, ['gates', 'coverage']);
      expect(coverage.out).not.toContain('0 edges via `to.files`');
      expect(json(root, ['gates', 'coverage']).body.rules?.find((r) => r.id === 'fence')?.hint).toBeUndefined();
    },
    60_000,
  );

  test(
    'import-edges `to.files` is JUDGED: an unmarked glob matching no file is an advisory dead unit; --fail-on-dead-units fails it',
    () => {
      const root = fixture({
        ...APPS,
        'sharkcraft/sharkcraft.config.ts': cfg(
          "baselines: [{ id: 'fence', baseline: 'baselines/fence.json', direction: 'additions-only', expectEmpty: true, compute: { kind: 'extractor', source: { files: ['appA/**/*.ts'], extract: 'import-edges', to: { files: ['appB/**', 'appTypo/**'] } } } }]",
        ),
      });
      const cov = json(root, ['gates', 'coverage']);
      expect(cov.code).toBe(0);
      const row = cov.body.rules?.find((r) => r.id === 'fence') as
        | { readonly units?: { readonly dead: readonly string[] }; readonly deadGlobs?: readonly string[] }
        | undefined;
      expect((row?.units?.dead ?? []).join('\n')).toContain('to.files: appTypo/**');
      expect(row?.deadGlobs).toEqual(['to.files: appTypo/**']);
      const text = shrk(root, ['gates', 'coverage']);
      expect(text.code).toBe(0);
      expect(text.out).not.toContain('Every rule is connected to something. ✓');
      expect(shrk(root, ['gates', 'coverage', '--fail-on-dead-units']).code).toBe(1);
      // K2: the plane verb lists the dead `to.files` under its ACCEPTED fence and withholds its ✓ (exit unchanged).
      const check = shrk(root, ['baseline', 'check']);
      expect(check.code).toBe(0);
      expect(check.out).toContain('Dead selector units (1)');
      expect(check.out).toContain('appTypo/**');
      expect(check.out).not.toContain('Every baseline matches its committed artifact. ✓');
    },
    60_000,
  );

  test(
    'V2 f1d: a fence over a DEAD input is no longer accepted — FAILED on every verb (0 → 1), never DRIFT',
    () => {
      const root = fixture({ ...APPS, 'sharkcraft/sharkcraft.config.ts': FENCE('appZ/**/*.ts') });
      const text = shrk(root, ['baseline', 'check']);
      expect(text.code).toBe(1);
      expect(text.out).toContain('FAILED — expectEmpty asserts an empty output, but its input selector matched nothing');
      expect(text.out).not.toContain('DRIFT');
      expect(text.out).not.toContain('bless it with');
      expect(shrk(root, ['gates', 'check']).code).toBe(1);
      const coverage = shrk(root, ['gates', 'coverage']);
      expect(coverage.code).toBe(1);
      expect(coverage.out).toContain('FAILED — expectEmpty asserts an empty output');
    },
    60_000,
  );

  test(
    'V2 f1h / P1: a ceiling over an EMPTY extractor is a loud skip on baseline check, gates check and gates coverage alike',
    () => {
      const ceiling = (extra: string): string =>
        cfg(
          `baselines: [{ id: 'ceiling', mode: 'ceiling', ceiling: 0${extra}, compute: { kind: 'extractor', source: { files: ['appZ/**/*.ts'], extract: 'import-edges', to: { files: ['appB/**'] } } } }]`,
        );
      const hard = fixture({ ...APPS, 'sharkcraft/sharkcraft.config.ts': ceiling('') });
      const text = shrk(hard, ['baseline', 'check']);
      expect(text.code).toBe(1);
      expect(text.out).toContain('FAILED — the compute produced nothing — a ceiling over an empty measurement proves nothing');
      expect(text.out).not.toContain('to spare');
      expect([shrk(hard, ['gates', 'check']).code, shrk(hard, ['gates', 'coverage']).code]).toEqual([1, 1]);
      // failOnEmpty: false → NOT VERIFIED (2) on all three, never ✓.
      const soft = fixture({ ...APPS, 'sharkcraft/sharkcraft.config.ts': ceiling(', failOnEmpty: false') });
      expect([
        shrk(soft, ['baseline', 'check']).code,
        shrk(soft, ['gates', 'check']).code,
        shrk(soft, ['gates', 'coverage']).code,
      ]).toEqual([2, 2, 2]);
    },
    60_000,
  );

  test(
    'expectEmpty on a CEILING stays legal and is honoured: an asserted-empty measurement over live inputs passes on every verb',
    () => {
      const root = fixture({
        ...APPS,
        'sharkcraft/sharkcraft.config.ts': cfg(
          "baselines: [{ id: 'ceiling-fence', mode: 'ceiling', ceiling: 0, expectEmpty: true, compute: { kind: 'extractor', source: { files: ['appA/**/*.ts'], extract: 'import-edges', to: { files: ['appB/**'] } } } }]",
        ),
      });
      for (const argv of [['baseline', 'check'], ['gates', 'check'], ['gates', 'coverage']]) {
        const r = json(root, argv);
        expect({ argv, code: r.code }).toEqual({ argv, code: 0 });
        expect(r.body.gate.accepted.join('\n')).toContain('ceiling-fence: accepted by expectEmpty: true');
      }
    },
    60_000,
  );

  test(
    'baseline list and generated list report the EFFECTIVE failOnEmpty (an error rule fails on empty by default)',
    () => {
      const root = fixture({
        ...APPS,
        'sharkcraft/sharkcraft.config.ts': cfg(
          "baselines: [{ id: 'b', baseline: 'baselines/fence.json', compute: { kind: 'extractor', source: { files: ['appA/**/*.ts'], extract: 'export-names' } } }], " +
            "generatedArtifacts: [{ id: 'g', generatedGlob: ['src/generated/**'], provenanceHeader: { mustMatch: 'GENERATED' } }]",
        ),
      });
      const baselines = JSON.parse(shrk(root, ['baseline', 'list', '--json']).out) as { baselines: { failOnEmpty: boolean }[] };
      const generated = JSON.parse(shrk(root, ['generated', 'list', '--json']).out) as { rules: { failOnEmpty: boolean }[] };
      expect([baselines.baselines[0]?.failOnEmpty, generated.rules[0]?.failOnEmpty]).toEqual([true, true]);
    },
    60_000,
  );

  test(
    'generated check renders a failOnEmpty rule that matched nothing as FAILED — <reason>, never "files differ from a fresh regen"',
    () => {
      const root = fixture({
        'src/a.ts': NOTHING,
        'sharkcraft/sharkcraft.config.ts': cfg(
          "generatedArtifacts: [{ id: 'g', generatedGlob: ['src/generated/**'], provenanceHeader: { mustMatch: 'GENERATED' } }]",
        ),
      });
      const r = shrk(root, ['generated', 'check']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('FAILED — 0 files matched generatedGlob (src/generated/**)');
      expect(r.out).not.toContain('differ from a fresh regen');
      expect(r.out).toContain(EMPTY_RULE_ADVICE);
    },
    60_000,
  );
});

describe('the one advice string and gates try', () => {
  test(
    'check wiring gives a soft-empty rule THE advice — never tells a failing rule to set failOnEmpty: true',
    () => {
      // One live rule so the verb reaches its per-rule "checked nothing" block
      // (an all-skipped run takes the "0 rules evaluated" path instead).
      const root = fixture({
        'src/core/a.ts': 'export const A_PLUGIN = 1;\n',
        'src/registry.ts': "export const REGISTERED = ['A'];\n",
        'sharkcraft/sharkcraft.config.ts': cfg(
          "wiringRules: [{ id: 'live', declared: { files: ['src/core/*.ts'], pattern: 'export const ([A-Z]+)_PLUGIN' }, registered: { files: ['src/registry.ts'], arrayProperty: 'REGISTERED' } }, " +
            "{ id: 'soft', severity: 'warning', declared: { files: ['src/plugins/**/*.ts'], pattern: 'export const ([A-Z]+)_PLUGIN' }, registered: { files: ['src/registry.ts'], arrayProperty: 'REGISTERED' } }]",
        ),
      });
      const r = shrk(root, ['check', 'wiring']);
      expect(r.code).toBe(2);
      expect(r.out).toContain(EMPTY_RULE_ADVICE);
      expect(r.out).not.toContain('Fix the selector, or set `failOnEmpty: true`');
    },
    60_000,
  );

  test(
    'gates try text prints the dead globs its JSON reports, and never says "connected over everything" over one',
    () => {
      const root = fixture({ 'src/core/a.ts': NOTHING, 'sharkcraft/sharkcraft.config.ts': cfg('') });
      write(
        root,
        'try-rule.json',
        JSON.stringify({ id: 'try-policy', surface: 'ts', pattern: 'debugger', message: 'm', files: ['src/core/**/*.ts', 'src/plugins/**/*.ts'] }),
      );
      const text = shrk(root, ['gates', 'try', '--rule-file', join(root, 'try-rule.json'), '--plane', 'policy']);
      expect(text.out).toContain('glob(s) dead: src/plugins/**/*.ts (matched 0 files)');
      expect(text.out).not.toContain('connected over everything it was asked to examine');
      const body = JSON.parse(
        shrk(root, ['gates', 'try', '--rule-file', join(root, 'try-rule.json'), '--plane', 'policy', '--json']).out,
      ) as { coverage: { deadGlobs: readonly string[] } };
      expect(body.coverage.deadGlobs).toEqual(['src/plugins/**/*.ts']);
      // A candidate that MARKS its planned glob is tried exactly as it will load.
      write(
        root,
        'try-planned.json',
        JSON.stringify({
          id: 'try-planned',
          surface: 'ts',
          pattern: 'debugger',
          message: 'm',
          files: ['src/core/**/*.ts', { pattern: 'src/plugins/**/*.ts', expectEmpty: true }],
        }),
      );
      const planned = shrk(root, ['gates', 'try', '--rule-file', join(root, 'try-planned.json'), '--plane', 'policy']);
      expect(planned.code).toBe(0);
      // The intended-empty unit reads as its ONE per-unit line (formatUnitLiveness)
      // under a neutral bullet — never a hand-built ✓ row (round 13 review).
      expect(planned.out).toContain('src/plugins/**/*.ts — intended empty (expectEmpty');
      expect(planned.out).not.toContain('✓ asserted empty');
      expect(planned.out).toContain('accepted by expectEmpty');
    },
    60_000,
  );
});

/**
 * Round-13 review (lane G): the surfaces the first pass left settling a planned
 * unit their own way. Each case failed before the review fix.
 */
describe('review — explain / try / wiring test / registry / baseline update agree with the plane verb', () => {
  const REG = "export const REGISTERED = ['A'];\n";
  const wiringRule = (id: string, files: readonly unknown[]): Record<string, unknown> => ({
    id,
    declared: { files, pattern: 'export const ([A-Z]+)_PLUGIN' },
    registered: { files: ['src/registry.ts'], arrayProperty: 'REGISTERED' },
  });

  test(
    'a fully planned wiring rule is accepted by check wiring --explain, wiring explain, gates explain and gates try — as by check wiring',
    () => {
      const planned = wiringRule('planned', [{ pattern: 'src/plugins/*.ts', expectEmpty: true }]);
      const root = fixture({
        'src/registry.ts': REG,
        'sharkcraft/sharkcraft.config.ts': cfg(`wiringRules: [${JSON.stringify(planned)}]`),
        'cand.json': JSON.stringify({ ...planned, id: 'cand' }),
      });
      expect(shrk(root, ['check', 'wiring']).code).toBe(0);
      // A verdict verb: it exited 1 ("SKIPPED … Verdict: errors") over the rule `check wiring` accepts.
      const explained = shrk(root, ['check', 'wiring', '--explain', 'planned']);
      expect(explained.code).toBe(0);
      expect(explained.out).toContain('planned: accepted by expectEmpty');
      expect(explained.out).not.toContain('SKIPPED');
      const body = JSON.parse(shrk(root, ['wiring', 'explain', 'planned', '--json']).out) as {
        readonly status: string;
        readonly verdict: string;
        readonly unitAcceptance?: { readonly acceptedBy?: string };
      };
      expect(body).toMatchObject({ status: 'passed', verdict: 'pass' });
      expect(body.unitAcceptance?.acceptedBy).toBe('expectEmpty');
      expect(shrk(root, ['gates', 'explain', 'planned']).out).toContain('planned: accepted by expectEmpty');
      // The rule-authoring REPL tries the candidate exactly as it will load (it settled 2).
      const tried = shrk(root, ['gates', 'try', '--rule-file', join(root, 'cand.json'), '--plane', 'wiring']);
      expect(tried.code).toBe(0);
      expect(tried.out).toContain('cand: accepted by expectEmpty');
    },
    60_000,
  );

  test(
    'wiring test normalises a marker candidate (never `glob.startsWith is not a function`) and reports a malformed one as misconfigured',
    () => {
      const root = fixture({
        'src/core/a.ts': 'export const A_PLUGIN = 1;\n',
        'src/registry.ts': REG,
        'sharkcraft/sharkcraft.config.ts': cfg(''),
      });
      const candidate = (entry: unknown): string => JSON.stringify(wiringRule('cand', ['src/core/*.ts', entry]));
      const planned = shrk(root, ['wiring', 'test', candidate({ pattern: 'src/plugins/*.ts', expectEmpty: true })]);
      expect(`${planned.out}${planned.err}`).not.toContain('Fatal');
      expect(planned.code).toBe(0);
      expect(planned.out).toContain('cand: accepted by expectEmpty');
      const bad = shrk(root, ['wiring', 'test', candidate({ pattern: 'src/plugins/*.ts', expectEmpty: 'yes' }), '--json']);
      expect(`${bad.out}${bad.err}`).not.toContain('Fatal');
      const report = JSON.parse(bad.out) as { readonly status: string; readonly diagnostics: readonly string[] };
      expect(report.status).toBe('error');
      expect(report.diagnostics.join('\n')).toContain('expectEmpty must be the literal true (got "yes")');
    },
    60_000,
  );

  test(
    'the registry verbs print a planned glob\'s acceptance on every exit-0 answer, as gates check does — partial marking, and an intended-empty guard',
    () => {
      const partial = fixture({
        'src/commands/a.ts': "name: 'a'\n",
        'sharkcraft/sharkcraft.config.ts': cfg(
          "registries: [{ name: 'r', source: { files: ['src/commands/*.ts', { pattern: 'src/commands2/*.ts', expectEmpty: true }], pattern: \"name: '([a-z]+)'\" } }]",
        ),
      });
      const line = 'r: accepted by expectEmpty: examined 0 of 1 globs, 1 asserted empty';
      expect(json(partial, ['gates', 'check']).body.gate.accepted.join('\n')).toContain(line);
      for (const argv of [
        ['registry', 'r', 'list'],
        ['registry', 'r', 'duplicates'],
        ['registry', 'r', 'exists', 'a'],
        ['registry', 'r', 'where', 'a'],
      ]) {
        const text = shrk(partial, argv);
        expect({ argv, code: text.code }).toEqual({ argv, code: 0 });
        expect(text.out).toContain(line);
        const body = JSON.parse(shrk(partial, [...argv, '--json']).out) as { readonly accepted?: readonly string[] };
        expect({ argv, accepted: (body.accepted ?? []).join('\n').includes(line) }).toEqual({ argv, accepted: true });
      }
      // An answer that is not a pass carries no acceptance (it is printed at exit 0 only).
      expect(shrk(partial, ['registry', 'r', 'exists', 'zz']).out).not.toContain('accepted by');
      const planned = fixture({
        'src/app.ts': 'export {};\n',
        'sharkcraft/sharkcraft.config.ts': cfg(
          "registries: [{ name: 'r', source: { files: [{ pattern: 'src/commands/*.ts', expectEmpty: true }], pattern: \"name: '([a-z]+)'\" } }]",
        ),
      });
      const guard = shrk(planned, ['registry', 'r', 'exists', 'z', '--fail-if-taken']);
      expect(guard.code).toBe(0);
      expect(guard.out).toContain('r: accepted by expectEmpty');
    },
    60_000,
  );

  test(
    'baseline update decides an EMPTY bless by unit count through the one settle (P1): a failOnEmpty ledger over a dead selector is refused; a fence over live inputs is blessed',
    () => {
      const dead = fixture({
        'appA/a.ts': 'export const a = 1;\n',
        'sharkcraft/sharkcraft.config.ts': cfg(
          "baselines: [{ id: 'r', baseline: 'baselines/r.json', compute: { kind: 'extractor', source: { files: ['appZ/**/*.ts'], extract: 'export-names' } } }]",
        ),
      });
      // It wrote `[]` at exit 0: the refusal read the serialised text, never `''` for an extractor.
      const refused = shrk(dead, ['baseline', 'update', '--id', 'r', '--json']);
      expect(refused.code).toBe(1);
      const body = JSON.parse(refused.out) as {
        readonly errors: readonly { readonly error: string }[];
        readonly written: readonly unknown[];
      };
      expect(body.errors[0]?.error).toContain('refusing to write an EMPTY baseline for a `failOnEmpty` rule');
      expect(body.errors[0]?.error).toContain('appZ/**/*.ts');
      expect(body.written).toEqual([]);
      const fence = fixture({
        'appA/a.ts': 'export const a = 1;\n',
        'appB/b.ts': 'export const b = 2;\n',
        'sharkcraft/sharkcraft.config.ts': cfg(
          "baselines: [{ id: 'fence', baseline: 'baselines/fence.json', direction: 'additions-only', expectEmpty: true, compute: { kind: 'extractor', source: { files: ['appA/**/*.ts'], extract: 'import-edges', to: { files: ['appB/**'] } } } }]",
        ),
      });
      expect(shrk(fence, ['baseline', 'update', '--id', 'fence']).code).toBe(0);
      expect(shrk(fence, ['baseline', 'check']).code).toBe(0);
    },
    60_000,
  );

  test(
    'P1: a COMMAND-compute fence that prints nothing is blessable (it was refused, exit 1), and `baseline check` then accepts it',
    () => {
      const root = fixture({
        'sharkcraft/sharkcraft.config.ts': cfg(
          "baselines: [{ id: 'f', baseline: 'baselines/f.txt', direction: 'additions-only', expectEmpty: true, compute: { kind: 'command', run: 'true' } }]",
        ),
      });
      const update = shrk(root, ['baseline', 'update', '--id', 'f']);
      expect(update.code).toBe(0);
      expect(update.out).toContain('wrote baselines/f.txt');
      const check = shrk(root, ['baseline', 'check']);
      expect(check.code).toBe(0);
      expect(check.out).toContain('f: accepted by expectEmpty: true');
    },
    60_000,
  );
});

/** The counts K6 reads off a verb's `--json`: the engine's (top level, when the plane has them) and the envelope's. */
interface IK6Json {
  readonly evaluated?: number;
  readonly acceptedEmpty?: number;
  readonly gate: { readonly exit: number; readonly evaluated: number; readonly acceptedEmpty?: number };
}

/**
 * K6 (round 13): a rule accepted as intended-empty examined 0 files — it is
 * ACCEPTED, never counted as evaluated. The envelope decides it with ONE
 * predicate (core's `ruleAcceptedAsIntendedEmpty`, over the record the
 * engines' settle put on the rule): `gate.evaluated` leaves it out and the
 * optional `gate.acceptedEmpty` counts it; the text prints `N evaluated, M
 * accepted as intended-empty`. Each case failed before the fix (gate.evaluated
 * counted the planned rule; the text printed `2 of 2`).
 */
describe('K6 — a rule accepted as intended-empty is counted apart, never as evaluated', () => {
  const k6 = (root: string, argv: readonly string[]): IK6Json =>
    JSON.parse(shrk(root, [...argv, '--json']).out) as IK6Json;
  // A registration idiom whose declared role is planned still READ its live
  // provided / consumed roles: it ran a comparison, so it IS evaluated (its
  // acceptance rides beside its coverage, as `unitAcceptance`).
  const READS_LIVE_ROLES = new Set(['planned-tokens']);

  for (const p of PLANES) {
    test(
      `${p.plane}: the plane verb and gates check count the planned rule as accepted, not evaluated`,
      () => {
        const root = fixture(p.files);
        const expected = READS_LIVE_ROLES.has(p.rule)
          ? { evaluated: 1, acceptedEmpty: undefined }
          : { evaluated: 0, acceptedEmpty: 1 };
        // The text prints the same count, the accepted rule named apart.
        const countLine = READS_LIVE_ROLES.has(p.rule) ? '1 of 1' : '0 of 1, 1 accepted as intended-empty';
        for (const argv of [p.verb, ['gates', 'check']]) {
          const { gate } = k6(root, argv);
          expect({ argv, exit: gate.exit, evaluated: gate.evaluated, acceptedEmpty: gate.acceptedEmpty }).toEqual({
            argv,
            exit: 0,
            ...expected,
          });
          const out = shrk(root, argv).out;
          expect({ argv, count: out.includes(countLine) }).toEqual({ argv, count: true });
          if (READS_LIVE_ROLES.has(p.rule)) expect(out).not.toContain('accepted as intended-empty');
        }
      },
      60_000,
    );
  }

  test(
    'policy-lint: `1 of 2, 1 accepted as intended-empty`; gate.evaluated excludes the planned rule on policy-lint and gates check',
    () => {
      const root = fixture({
        'src/core/a.ts': NOTHING,
        'sharkcraft/sharkcraft.config.ts': cfg(
          "policyRules: [{ id: 'live', surface: 'ts', pattern: 'debugger', message: 'm', files: ['src/core/**/*.ts'] }, " +
            "{ id: 'planned', surface: 'ts', pattern: 'debugger', message: 'm', files: [{ pattern: 'src/ui/**/*.ts', expectEmpty: true }] }]",
        ),
      });
      const text = shrk(root, ['policy-lint']);
      expect(text.code).toBe(0);
      expect(text.out).toContain('1 of 2, 1 accepted as intended-empty');
      expect(text.out).not.toContain('2 of 2');
      expect(text.out).toContain('planned: accepted by expectEmpty');
      const lint = k6(root, ['policy-lint']);
      expect(lint.gate).toMatchObject({ exit: 0, evaluated: 1, acceptedEmpty: 1 });
      // One answer on both paths: the engine's counts (its `evaluated` keeps the
      // accepted rule only for the "nothing ran" guard) and the envelope's predicate.
      expect([(lint.evaluated ?? 0) - (lint.acceptedEmpty ?? 0), lint.acceptedEmpty]).toEqual([
        lint.gate.evaluated,
        lint.gate.acceptedEmpty,
      ]);
      const gates = k6(root, ['gates', 'check']);
      expect(gates.gate).toMatchObject({ exit: 0, evaluated: 1, acceptedEmpty: 1 });
      expect(shrk(root, ['gates', 'check']).out).toContain('1 of 2, 1 accepted as intended-empty');
      // Control: with no planned rule the optional key is absent and nothing is printed apart.
      const live = fixture({
        'src/core/a.ts': NOTHING,
        'sharkcraft/sharkcraft.config.ts': cfg(
          "policyRules: [{ id: 'live', surface: 'ts', pattern: 'debugger', message: 'm', files: ['src/core/**/*.ts'] }]",
        ),
      });
      const control = k6(live, ['policy-lint']);
      expect(control.gate.evaluated).toBe(1);
      expect('acceptedEmpty' in control.gate).toBe(false);
      expect(shrk(live, ['policy-lint']).out).not.toContain('accepted as intended-empty');
    },
    60_000,
  );

  test(
    'check wiring: `1 of 2, 1 accepted as intended-empty`; gate.evaluated excludes the planned rule on check wiring and gates check',
    () => {
      const side = (files: string): string =>
        `declared: { files: ${files}, pattern: 'export const ([A-Z]+)_PLUGIN' }, registered: { files: ['src/registry.ts'], arrayProperty: 'REGISTERED' }`;
      const root = fixture({
        'src/core/a.ts': 'export const A_PLUGIN = 1;\n',
        'src/registry.ts': "export const REGISTERED = ['A'];\n",
        'sharkcraft/sharkcraft.config.ts': cfg(
          `wiringRules: [{ id: 'live', ${side("['src/core/*.ts']")} }, { id: 'planned', ${side("[{ pattern: 'src/plugins/*.ts', expectEmpty: true }]")} }]`,
        ),
      });
      const text = shrk(root, ['check', 'wiring']);
      expect(text.code).toBe(0);
      expect(text.out).toContain('1 of 2, 1 accepted as intended-empty');
      expect(text.out).not.toContain('2 of 2');
      expect(text.out).toContain('planned: accepted by expectEmpty');
      const wiring = k6(root, ['check', 'wiring']);
      expect(wiring.gate).toMatchObject({ exit: 0, evaluated: 1, acceptedEmpty: 1 });
      expect([(wiring.evaluated ?? 0) - (wiring.acceptedEmpty ?? 0), wiring.acceptedEmpty]).toEqual([
        wiring.gate.evaluated,
        wiring.gate.acceptedEmpty,
      ]);
      expect(k6(root, ['gates', 'check']).gate).toMatchObject({ exit: 0, evaluated: 1, acceptedEmpty: 1 });
    },
    60_000,
  );
});
