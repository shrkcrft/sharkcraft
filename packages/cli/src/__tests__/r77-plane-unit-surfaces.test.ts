/**
 * r77 — every plane surface says what `gates coverage` and `check boundaries`
 * say about a selector unit, and every verdict says why it is not a ✓
 * (round 13 fixer F1: K2, K8, K9 and the routed review findings).
 *
 *   - K2: `policy-lint`, `check wiring`, `registry <name> list|duplicates`,
 *     `gates check` and the explain views print ONE shared unit-state block — a
 *     LOCAL marker that went live withholds the ✓ (exit unchanged), a dead unit
 *     of a live rule is listed with the causes once;
 *   - the ONE empty-rule advice reaches every branch with the rule's real
 *     `fails` (a failing rule, a soft skip, the 0-evaluated returns; K8);
 *   - `gates coverage` never prints a hand-built `✓ asserted empty` row;
 *   - `wiring chain` settles like its siblings; the scoped / no-idiom
 *     registration answers carry the documented `--json` keys;
 *   - `baseline update` never proposes a ceiling over an empty measurement (K9);
 *   - `boundaries explain` words a marker as a declaration, never a state.
 *
 * Real temp workspaces, the real config loader, the CLI spawned from source.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEAD_SELECTOR_CAUSES } from '@shrkcrft/core';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_MAIN = join(REPO_ROOT, 'packages', 'cli', 'src', 'main.ts');
const T = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function fx(config: string, files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-plane-units-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': `export default { projectName: 'fx', ${config} };\n`,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

function shrk(root: string, argv: readonly string[]): { readonly code: number; readonly out: string; readonly err: string } {
  const r = spawnSync('bun', [CLI_MAIN, '--no-hints', '--cwd', root, ...argv], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const PAT = "'plugin[(]([a-z]+)[)]'";
const FAILS_TRUE = 'set `failOnEmpty: false`';
const FAILS_FALSE = 'set `failOnEmpty: true`';

/** A policy rule whose marked `src/ui` glob went live (src/ui/b.ts exists). */
const POLICY_WENT_LIVE = fx(
  "policyRules: [{ id: 'no-dbg', surface: 'ts', pattern: 'debugger', message: 'm', files: ['src/core/**/*.ts', { pattern: 'src/ui/**/*.ts', expectEmpty: true }] }]",
  { 'src/core/a.ts': 'export const a = 1;\n', 'src/ui/b.ts': 'export const b = 1;\n' },
);

/** A wiring rule whose marked `src/plugins` declared glob went live. */
const WIRING_WENT_LIVE = fx(
  `wiringRules: [{ id: 'w', declared: { files: ['src/core/*.ts', { pattern: 'src/plugins/*.ts', expectEmpty: true }], pattern: ${PAT} }, registered: { files: ['src/registry.ts'], pattern: ${PAT} } }]`,
  {
    'src/core/a.ts': 'plugin(alpha);\n',
    'src/plugins/b.ts': 'plugin(beta);\n',
    'src/registry.ts': 'plugin(alpha); plugin(beta);\n',
  },
);

describe('K2 — ONE unit-state block on every plane verb', () => {
  test(
    'policy-lint: a LOCAL went-live marker is listed and withholds the ✓ (exit unchanged)',
    () => {
      const r = shrk(POLICY_WENT_LIVE, ['policy-lint']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('expectEmpty markers that went live (1)');
      expect(r.out).toContain('no-dbg: src/ui/**/*.ts — expectEmpty is stale');
      expect(r.out).not.toContain('No policy violations on the scanned surfaces. ✓');
      expect(r.out).toContain('1 expectEmpty unit(s) went live — remove the markers');
    },
    T,
  );

  test(
    'check wiring and gates check: the went-live block, a ⚠ row, no ✓ sentence',
    () => {
      const wiring = shrk(WIRING_WENT_LIVE, ['check', 'wiring']);
      expect(wiring.code).toBe(0);
      expect(wiring.out).toContain('expectEmpty markers that went live (1)');
      expect(wiring.out).toContain('  ⚠ w  (declared');
      expect(wiring.out).not.toContain('every declared token is registered. ✓');
      const gates = shrk(WIRING_WENT_LIVE, ['gates', 'check']);
      expect(gates.code).toBe(0);
      expect(gates.out).toContain('expectEmpty markers that went live (1)');
      expect(gates.out).toContain('⚠ [wiring] w');
      expect(gates.out).not.toContain('Every declared rule ran and passed. ✓');
    },
    T,
  );

  test(
    'the explain views list a LOCAL went-live unit (check wiring --explain, wiring explain, gates explain, policy-lint explain)',
    () => {
      for (const argv of [
        ['check', 'wiring', '--explain', 'w'],
        ['wiring', 'explain', 'w'],
        ['gates', 'explain', 'w'],
      ]) {
        const r = shrk(WIRING_WENT_LIVE, argv);
        expect({ argv, block: r.out.includes('expectEmpty markers that went live (1)') }).toEqual({ argv, block: true });
      }
      for (const argv of [['policy-lint', 'explain', 'no-dbg'], ['gates', 'explain', 'no-dbg']]) {
        const r = shrk(POLICY_WENT_LIVE, argv);
        expect({ argv, block: r.out.includes('expectEmpty markers that went live (1)') }).toEqual({ argv, block: true });
      }
    },
    T,
  );

  test(
    'registry <name> list | duplicates: the went-live block, and duplicates withholds its ✓',
    () => {
      const root = fx(
        "registries: [{ name: 'ids', source: { files: ['src/ids/*.ts', { pattern: 'src/planned/*.ts', expectEmpty: true }], pattern: \"id[(]'([a-z]+)'[)]\" } }]",
        { 'src/ids/a.ts': "id('a');\n", 'src/planned/b.ts': "id('b');\n" },
      );
      const list = shrk(root, ['registry', 'ids', 'list']);
      expect(list.code).toBe(0);
      expect(list.out).toContain('expectEmpty markers that went live (1)');
      const dupes = shrk(root, ['registry', 'ids', 'duplicates']);
      expect(dupes.code).toBe(0);
      expect(dupes.out).toContain('expectEmpty markers that went live (1)');
      expect(dupes.out).not.toContain('scanned). ✓');
    },
    T,
  );

  test(
    'a DEAD glob of a rule that still matched: listed with the causes once, on the verb and on gates coverage',
    () => {
      const root = fx(
        "policyRules: [{ id: 'p', surface: 'ts', pattern: 'debugger', message: 'm', files: ['src/core/**/*.ts', 'src/gone/**/*.ts'] }]",
        { 'src/core/a.ts': 'export const a = 1;\n' },
      );
      const lint = shrk(root, ['policy-lint']);
      expect(lint.code).toBe(0);
      expect(lint.out).toContain('Dead selector units (1)');
      expect(lint.out).toContain(`Dead selectors: ${DEAD_SELECTOR_CAUSES}.`);
      expect(lint.out).not.toContain('No policy violations on the scanned surfaces. ✓');
      const coverage = shrk(root, ['gates', 'coverage']);
      expect(coverage.code).toBe(0);
      expect(coverage.out).toContain(`Dead selectors: ${DEAD_SELECTOR_CAUSES}.`);
    },
    T,
  );
});

describe('the ONE empty-rule advice reaches every branch, with the rule’s REAL fails', () => {
  const failingWiring = (): string =>
    fx(
      `wiringRules: [{ id: 'w', declared: { files: ['src/nope/*.ts'], pattern: ${PAT} }, registered: { files: ['src/registry.ts'], pattern: ${PAT} } }]`,
      { 'src/registry.ts': 'plugin(alpha);\n' },
    );

  test(
    'check wiring (0 evaluated) and gates coverage: a failing (failOnEmpty) rule is advised to set failOnEmpty: false',
    () => {
      const root = failingWiring();
      const wiring = shrk(root, ['check', 'wiring']);
      expect(wiring.code).toBe(1);
      expect(wiring.out).toContain(FAILS_TRUE);
      expect(wiring.out).not.toContain(FAILS_FALSE);
      const coverage = shrk(root, ['gates', 'coverage']);
      expect(coverage.code).toBe(1);
      expect(coverage.out).toContain(FAILS_TRUE);
    },
    T,
  );

  test(
    'policy-lint (0 evaluated): the failing rule and the soft rule each get their own sentence',
    () => {
      const hard = fx("policyRules: [{ id: 'p', surface: 'ts', pattern: 'x', message: 'm', files: ['src/nope/**/*.ts'] }]", {
        'src/a.ts': 'export const a = 1;\n',
      });
      const h = shrk(hard, ['policy-lint']);
      expect(h.code).toBe(1);
      expect(h.out).toContain(FAILS_TRUE);
      const soft = fx(
        "policyRules: [{ id: 'p', surface: 'ts', pattern: 'x', message: 'm', files: ['src/nope/**/*.ts'], failOnEmpty: false }]",
        { 'src/a.ts': 'export const a = 1;\n' },
      );
      const s = shrk(soft, ['policy-lint']);
      expect(s.code).toBe(2);
      expect(s.out).toContain(FAILS_FALSE);
    },
    T,
  );

  test(
    'baseline check, generated check and docs references check (K8): a SOFT skip is advised to set failOnEmpty: true',
    () => {
      const baseline = fx(
        "baselines: [{ id: 'bl', severity: 'warning', failOnEmpty: false, baseline: 'baselines/e.json', direction: 'two-way', compute: { kind: 'extractor', source: { files: ['nowhere/*.ts'], extract: 'export-names' } } }]",
        { 'baselines/e.json': '[]\n' },
      );
      const b = shrk(baseline, ['baseline', 'check']);
      expect(b.code).toBe(2);
      expect(b.out).toContain(FAILS_FALSE);
      const generated = fx(
        "generatedArtifacts: [{ id: 'g', generatedGlob: ['nowhere/*.ts'], regen: 'true {TMP}', severity: 'warning', failOnEmpty: false }]",
      );
      const g = shrk(generated, ['generated', 'check', '--headers-only']);
      expect(g.code).toBe(2);
      expect(g.out).toContain(FAILS_FALSE);
      const docs = fx(
        // `command` ids are always registered (the live command index), so the
        // rule SKIPS on its empty scope rather than refusing an empty registry.
        "docReferences: [{ id: 'd', files: ['nowhere/**/*.md'], tokenPattern: 'shrk [a-z]+', resolvesAs: ['command'], severity: 'warning', failOnEmpty: false }]",
      );
      const d = shrk(docs, ['docs', 'references', 'check']);
      expect(d.code).toBe(2);
      expect(d.out).toContain('SKIPPED');
      expect(d.out).toContain(FAILS_FALSE);
    },
    T,
  );
});

describe('gates coverage never hand-builds a ✓ row for an intended-empty unit', () => {
  test(
    'a FAILED rule with a marked sibling: the unit reads as its formatUnitLiveness line, never `✓ asserted empty`',
    () => {
      // Live declared files that yield 0 tokens (NoUnits — never assertable) and a planned sibling.
      const root = fx(
        `wiringRules: [{ id: 'w', declared: { files: ['src/core/*.ts', { pattern: 'src/plugins/*.ts', expectEmpty: true }], pattern: ${PAT} }, registered: { files: ['src/registry.ts'], pattern: ${PAT} } }]`,
        { 'src/core/a.ts': 'export const nothing = 1;\n', 'src/registry.ts': 'plugin(alpha);\n' },
      );
      const r = shrk(root, ['gates', 'coverage']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('src/plugins/*.ts — intended empty (expectEmpty');
      expect(r.out).not.toContain('✓ asserted empty');
    },
    T,
  );
});

describe('the registration graph — `wiring chain` settles like its siblings; every answer carries the keys', () => {
  const IDIOM = (declared: string): string =>
    `registrationGraph: [ { name: 'di', declared: { files: [${declared}], pattern: 'export const ([A-Z_]+) = new InjectionToken' }, ` +
    "provided: { files: ['src/module.ts'], pattern: 'provide[(]([A-Z_]+)' }, consumed: { files: ['src/use.ts'], pattern: 'inject[(]([A-Z_]+)' } } ]";
  const FILES = { 'src/module.ts': 'provide(A_TOKEN);\n', 'src/use.ts': 'inject(A_TOKEN);\n' };
  const KEYS = ['coverage', 'exitCode', 'verdict', 'shortfalls', 'accepted', 'gate'];

  test(
    'a dead declared role: NOT VERIFIED (2), never "✓ declared → provided → consumed"; --json carries the envelope',
    () => {
      const root = fx(IDIOM("'src/planned/tokens.ts'"), FILES);
      const text = shrk(root, ['wiring', 'chain', 'A_TOKEN']);
      expect(text.code).toBe(2);
      expect(text.out).toContain('NOT VERIFIED');
      expect(text.out).not.toContain('✓ declared → provided → consumed');
      const json = JSON.parse(shrk(root, ['wiring', 'chain', 'A_TOKEN', '--json']).out) as Record<string, unknown>;
      for (const k of KEYS) expect({ k, has: k in json }).toEqual({ k, has: true });
      expect(json['exitCode']).toBe(2);
    },
    T,
  );

  test(
    'a live chain keeps its ✓; a planned (marked) declared role is accepted and printed',
    () => {
      const live = fx(IDIOM("'src/tokens.ts'"), { ...FILES, 'src/tokens.ts': 'export const A_TOKEN = new InjectionToken();\n' });
      const l = shrk(live, ['wiring', 'chain', 'A_TOKEN']);
      expect(l.code).toBe(0);
      expect(l.out).toContain('✓ declared → provided → consumed.');
      const planned = fx(IDIOM("{ pattern: 'src/planned/tokens.ts', expectEmpty: true }"), FILES);
      const p = shrk(planned, ['wiring', 'chain', 'A_TOKEN']);
      expect(p.code).toBe(0);
      expect(p.out).toContain('accepted by expectEmpty');
    },
    T,
  );

  test(
    'wiring unprovided|orphans: the empty-scope, scoped-error and no-idiom answers carry every documented key',
    () => {
      const root = fx(IDIOM("'src/tokens.ts'"), { ...FILES, 'src/tokens.ts': 'export const A_TOKEN = new InjectionToken();\n' });
      for (const argv of [
        ['wiring', 'unprovided', '--base', 'no-such-ref-r77', '--json'],
        ['wiring', 'orphans', '--base', 'no-such-ref-r77', '--json'],
      ]) {
        const r = shrk(root, argv);
        expect({ argv, code: r.code }).toEqual({ argv, code: 2 });
        const json = JSON.parse(r.out) as Record<string, unknown>;
        for (const k of KEYS) expect({ argv, k, has: k in json }).toEqual({ argv, k, has: true });
      }
      const none = fx('');
      for (const verb of ['unprovided', 'orphans']) {
        const r = shrk(none, ['wiring', verb, '--json']);
        expect(r.code).toBe(2);
        const json = JSON.parse(r.out) as Record<string, unknown>;
        for (const k of KEYS) expect({ verb, k, has: k in json }).toEqual({ verb, k, has: true });
      }
    },
    T,
  );
});

describe('K9 — baseline update never proposes a ceiling over an empty measurement', () => {
  const CEILING = (extra: string): string =>
    `baselines: [{ id: 'ceiling', mode: 'ceiling', ceiling: 3${extra}, compute: { kind: 'extractor', source: { files: ['appZ/**/*.ts'], extract: 'import-edges', to: { files: ['appB/**'] } } } }]`;

  test(
    'a soft rule: the loud skip (2, `skipped` in --json), never `edit config … ceiling: 0`; a failOnEmpty rule is refused (1)',
    () => {
      const soft = fx(CEILING(', failOnEmpty: false'), { 'appB/b.ts': 'export const b = 2;\n' });
      const text = shrk(soft, ['baseline', 'update']);
      expect(text.code).toBe(2);
      expect(text.out).toContain('ceiling: no ceiling proposed — the compute produced nothing');
      expect(text.out).not.toContain('edit config');
      expect(text.out).not.toContain('ceiling: 0');
      const json = JSON.parse(shrk(soft, ['baseline', 'update', '--json']).out) as {
        readonly skipped?: readonly { readonly id: string }[];
        readonly reblessed: readonly unknown[];
        readonly exitCode: number;
      };
      expect(json.exitCode).toBe(2);
      expect(json.skipped?.map((s) => s.id)).toEqual(['ceiling']);
      expect(json.reblessed).toEqual([]);
      const hard = fx(CEILING(''), { 'appB/b.ts': 'export const b = 2;\n' });
      const h = shrk(hard, ['baseline', 'update']);
      expect(h.code).toBe(1);
      expect(h.out).toContain('refusing to propose a ceiling from an EMPTY measurement');
    },
    T,
  );
});

describe('a static boundary rule view words a marker as a declaration, never a state', () => {
  test(
    'boundaries explain over a marker that went live: `expectEmpty marker … (state: see …)`, never `intended empty`',
    () => {
      const root = fx("boundaryFiles: ['boundaries.ts']", {
        'sharkcraft/boundaries.ts': `export default [{ id: 'b.partial', title: 'B', from: ['packages/app/**'],
  forbiddenImports: ['@scope/kernel-*', { pattern: '@census/future', expectEmpty: true }] }];\n`,
        'packages/app/src/a.ts': 'export const a = 1;\n',
        'packages/future/package.json': JSON.stringify({ name: '@census/future', version: '0.0.0' }),
      });
      const r = shrk(root, ['boundaries', 'explain', 'b.partial']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('expectEmpty marker');
      expect(r.out).toContain('forbiddenImports @census/future — no reason given (state: see `shrk check boundaries`)');
      expect(r.out).not.toMatch(/intended empty\s+forbiddenImports/);
    },
    T,
  );
});

/**
 * K6 (round 13): `gates explain` on a registry or a registration idiom printed
 * no unit-state block — a planned glob, a went-live marker and a dead glob were
 * all invisible there, while the wiring and policy explain views listed them.
 * Every explain view now prints THE shared block (`unitStateNotes`, each line
 * `formatUnitLiveness`), intended-empty units included.
 */
describe('K6 — every explain view names each unit state through THE shared block', () => {
  test(
    'gates explain <registry>: the planned glob’s unit-state line; a went-live marker, the went-live block',
    () => {
      const planned = fx(
        "registries: [{ name: 'commands', source: { files: [{ pattern: 'src/commands/**/*.ts', expectEmpty: true }], pattern: \"name: '([a-z]+)'\" } }]",
        { 'src/app.ts': 'export const nothing = 1;\n' },
      );
      const p = shrk(planned, ['gates', 'explain', 'commands']);
      expect(p.code).toBe(0);
      expect(p.out).toContain('Intended-empty selector units (1)');
      expect(p.out).toContain('· commands: src/commands/**/*.ts — intended empty (expectEmpty)');
      const wentLive = fx(
        "registries: [{ name: 'ids', source: { files: ['src/ids/*.ts', { pattern: 'src/planned/*.ts', expectEmpty: true }], pattern: \"id[(]'([a-z]+)'[)]\" } }]",
        { 'src/ids/a.ts': "id('a');\n", 'src/planned/b.ts': "id('b');\n" },
      );
      const w = shrk(wentLive, ['gates', 'explain', 'ids']);
      expect(w.code).toBe(0);
      expect(w.out).toContain('expectEmpty markers that went live (1)');
      expect(w.out).toContain('• ids: src/planned/*.ts — expectEmpty is stale');
    },
    T,
  );

  test(
    'gates explain <registration idiom>: the planned declared role and a dead provided glob, each as its one per-unit line',
    () => {
      const root = fx(
        "registrationGraph: [{ name: 'di', declared: { files: [{ pattern: 'src/planned/tokens.ts', expectEmpty: true }], pattern: 'export const ([A-Z_]+) = new InjectionToken' }, " +
          "provided: { files: ['src/module.ts', 'src/gone/*.ts'], pattern: 'provide[(]([A-Z_]+)' }, consumed: { files: ['src/use.ts'], pattern: 'inject[(]([A-Z_]+)' } }]",
        { 'src/module.ts': 'provide(A_TOKEN);\n', 'src/use.ts': 'inject(A_TOKEN);\n' },
      );
      const r = shrk(root, ['gates', 'explain', 'di']);
      expect(r.code).toBe(0);
      expect(r.out).toContain('· di: declared: src/planned/tokens.ts — intended empty (expectEmpty)');
      expect(r.out).toContain('Dead selector units (1)');
      expect(r.out).toContain('• di: provided: src/gone/*.ts');
      expect(r.out).toContain(`Dead selectors: ${DEAD_SELECTOR_CAUSES}.`);
    },
    T,
  );

  test(
    'the policy and wiring explain views print the same intended-empty line',
    () => {
      const policy = fx(
        "policyRules: [{ id: 'planned', surface: 'ts', pattern: 'debugger', message: 'm', files: ['src/core/**/*.ts', { pattern: 'src/ui/**/*.ts', expectEmpty: true }] }]",
        { 'src/core/a.ts': 'export const a = 1;\n' },
      );
      for (const argv of [['gates', 'explain', 'planned'], ['policy-lint', 'explain', 'planned']]) {
        const out = shrk(policy, argv).out;
        expect({ argv, line: out.includes('· planned: src/ui/**/*.ts — intended empty (expectEmpty)') }).toEqual({ argv, line: true });
      }
      const wiring = fx(
        `wiringRules: [{ id: 'w', declared: { files: ['src/core/*.ts', { pattern: 'src/plugins/*.ts', expectEmpty: true }], pattern: ${PAT} }, registered: { files: ['src/registry.ts'], pattern: ${PAT} } }]`,
        { 'src/core/a.ts': 'plugin(alpha);\n', 'src/registry.ts': 'plugin(alpha);\n' },
      );
      for (const argv of [['gates', 'explain', 'w'], ['wiring', 'explain', 'w']]) {
        const out = shrk(wiring, argv).out;
        expect({ argv, line: out.includes('· w: declared: src/plugins/*.ts — intended empty (expectEmpty)') }).toEqual({ argv, line: true });
      }
    },
    T,
  );
});
