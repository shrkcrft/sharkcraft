/**
 * Round 12 (12.2a) — LOCK: one scope authority for a glob list, on every plane.
 *
 * "Which files does this list read?" used to be answered by each engine with
 * the raw OR primitive (`matchesAny`), which treats `!` as a literal character
 * — so a negation was silently ignored on seven planes while the boundary
 * plane honoured it through a parser of its own. Two code paths answering one
 * question, agreeing only by coincidence.
 *
 * The lock is the property itself, per plane: the files an engine selects for
 * a list ≡ the walked POSITIVE set filtered by `globListSelects`. Plus union
 * isolation (one rule's `!` never removes a file from another rule's scope, on
 * the engines that walk a union once), and a grep lock so the raw OR primitive
 * never returns to gate-plane selection. Real trees, the real engines.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type {
  IDocReferenceRule,
  IGeneratedArtifactRule,
  IPolicyRule,
  IRegistrationIdiom,
  IWiringRule,
  IWiringSource,
} from '@shrkcrft/core';
import {
  buildRegistrationGraph,
  computeBaselineFromExtractor,
  globListSelects,
  inspectSource,
  runPolicyLint,
  runWiring,
  scanGeneratedFiles,
  scanRegistry,
  walkMatching,
} from '@shrkcrft/boundaries';
import { checkDocReferences, inspectSharkcraft, warmReferenceRegistries } from '@shrkcrft/inspector';

/** Every file carries one `_ID` export and one `MARK`, so each engine's output names the files it read. */
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
  'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', templateFiles: ['templates.ts'] };\n",
  'sharkcraft/templates.ts':
    "export default [{ id: 'gmc.handler', name: 'Handler', description: 'A handler construct.', files: [] }];\n",
  'src/a.ts': 'export const A_ID = 1; // MARK\n',
  'src/a.spec.ts': 'export const A_SPEC_ID = 1; // MARK\n',
  'src/deep/b.ts': 'export const B_ID = 1; // MARK\n',
  'src/deep/b.spec.ts': 'export const B_SPEC_ID = 1; // MARK\n',
  'lib/c.ts': 'export const C_ID = 1; // MARK\n',
  'reg/reg.ts': 'export const REG_ID = 1; // MARK\nexport const REG = [NOT_AN_ID];\n',
  'docs/a.md': 'See `gmc.handler`.\n',
  'docs/b.md': 'Also `gmc.handler`.\n',
  'docs/drafts/c.md': 'And `gmc.handler`.\n',
};

const ID_FILE: Record<string, string> = {
  A_ID: 'src/a.ts',
  A_SPEC_ID: 'src/a.spec.ts',
  B_ID: 'src/deep/b.ts',
  B_SPEC_ID: 'src/deep/b.spec.ts',
  C_ID: 'lib/c.ts',
  REG_ID: 'reg/reg.ts',
};

/** Lists with negations in every position, including one that leads. */
const LISTS: readonly (readonly string[])[] = [
  ['src/**/*.ts', '!src/**/*.spec.ts'],
  ['!src/deep/**', 'src/**/*.ts', 'lib/*.ts'],
  ['**/*.ts', '!**/b*.ts', '!src/a.spec.ts'],
];

/** The SharkCraft dir is pruned, as every plane walk prunes it. */
const EX = ['sharkcraft'];

const REG_SIDE: IWiringSource = { files: ['reg/reg.ts'], extract: 'array-members', anchor: 'REG' };

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r76-scope-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** THE expected selection: the positive walk, filtered by the one scope test. */
function selected(root: string, list: readonly string[]): string[] {
  return walkMatching(root, list, new Set(EX))
    .filter((p) => globListSelects(p, list))
    .sort();
}

const distinct = (files: readonly string[]): string[] => [...new Set(files)].sort();

describe('list ≡ select — every plane selects exactly the positive walk its list selects', () => {
  for (const list of LISTS) {
    test(JSON.stringify(list), () => {
      const root = tree();
      const want = selected(root, list);
      const src: IWiringSource = { files: list, extract: 'export-names', match: '_ID$' };

      // The extraction primitive every coverage adapter reads.
      expect(distinct(inspectSource(root, src, EX).sites.map((s) => s.file))).toEqual(want);

      const wiringRule: IWiringRule = { id: 'w', severity: 'warning', declared: src, registered: REG_SIDE };
      const wiring = runWiring(root, [wiringRule], { excludeDirs: EX });
      expect(distinct(wiring.violations.map((v) => v.file))).toEqual(want);

      const policyRule: IPolicyRule = { id: 'p', surface: 'ts', files: list, pattern: 'MARK', message: 'm', severity: 'warning' };
      expect(distinct(runPolicyLint(root, [policyRule], { excludeDirs: EX }).findings.map((f) => f.file))).toEqual(want);

      const registry = scanRegistry(root, { name: 'r', source: src }, { excludeDirs: EX });
      expect(distinct(registry.entries.flatMap((e) => e.sites.map((s) => s.file)))).toEqual(want);

      const idiom: IRegistrationIdiom = { name: 'i', declared: src, provided: REG_SIDE, consumed: REG_SIDE };
      const graph = buildRegistrationGraph(root, [idiom], { excludeDirs: EX });
      expect(distinct(graph.tokens.flatMap((t) => t.declared.map((s) => s.file)))).toEqual(want);

      expect(distinct(computeBaselineFromExtractor(root, src, EX).ids.map((id) => ID_FILE[id]!))).toEqual(want);

      const gen: IGeneratedArtifactRule = { id: 'g', generatedGlob: list, provenanceHeader: { mustMatch: 'MARK' } };
      expect([...scanGeneratedFiles(root, gen, EX).generated.keys()].sort()).toEqual(want);
    });
  }

  test('doc references: the documents a rule scans are the positive walk its list selects', async () => {
    const root = tree();
    const inspection = await inspectSharkcraft({ cwd: root });
    await warmReferenceRegistries(inspection);
    for (const list of [
      ['docs/**/*.md', '!docs/drafts/**'],
      ['!docs/a.md', 'docs/**/*.md'],
    ]) {
      const want = selected(root, list);
      const rule: IDocReferenceRule = {
        id: 'd',
        files: list,
        tokenPattern: '\\bgmc[.-][a-z0-9-]+\\b',
        resolvesAs: ['template'],
        requireContext: 'backtick',
      };
      const res = checkDocReferences(root, rule, inspection, EX);
      expect({ list, scanned: res.filesScanned, error: res.error }).toEqual({ list, scanned: want.length, error: undefined });
      expect(distinct(res.tokens.map((t) => t.file))).toEqual(want);
    }
  });
});

describe("UNION ISOLATION — one rule's negation never removes a file from another rule's scope", () => {
  const NO_SPEC = ['src/**/*.ts', '!src/**/*.spec.ts'];
  const ONLY_SPEC = ['src/**/*.spec.ts'];

  test('policy: two rules walked as one union', () => {
    const root = tree();
    const report = runPolicyLint(
      root,
      [
        { id: 'no-spec', surface: 'ts', files: NO_SPEC, pattern: 'MARK', message: 'm', severity: 'warning' },
        { id: 'only-spec', surface: 'ts', files: ONLY_SPEC, pattern: 'MARK', message: 'm', severity: 'warning' },
      ],
      { excludeDirs: EX },
    );
    const filesOf = (id: string): string[] => distinct(report.findings.filter((f) => f.ruleId === id).map((f) => f.file));
    expect(filesOf('no-spec')).toEqual(['src/a.ts', 'src/deep/b.ts']);
    expect(filesOf('only-spec')).toEqual(['src/a.spec.ts', 'src/deep/b.spec.ts']);
  });

  test('wiring: two rules walked as one union', () => {
    const root = tree();
    const report = runWiring(
      root,
      [
        { id: 'no-spec', severity: 'warning', declared: { files: NO_SPEC, extract: 'export-names', match: '_ID$' }, registered: REG_SIDE },
        { id: 'only-spec', severity: 'warning', declared: { files: ONLY_SPEC, extract: 'export-names', match: '_ID$' }, registered: REG_SIDE },
      ],
      { excludeDirs: EX },
    );
    const filesOf = (id: string): string[] => distinct(report.violations.filter((v) => v.ruleId === id).map((v) => v.file));
    expect(filesOf('no-spec')).toEqual(['src/a.ts', 'src/deep/b.ts']);
    expect(filesOf('only-spec')).toEqual(['src/a.spec.ts', 'src/deep/b.spec.ts']);
  });

  test("registration: one role's `!` never hides another role's file", () => {
    const root = tree();
    const graph = buildRegistrationGraph(
      root,
      [
        {
          name: 'i',
          declared: { files: NO_SPEC, extract: 'export-names', match: '_ID$' },
          provided: REG_SIDE,
          consumed: { files: ONLY_SPEC, extract: 'export-names', match: '_ID$' },
        },
      ],
      { excludeDirs: EX },
    );
    const spec = graph.tokens.find((t) => t.token === 'A_SPEC_ID');
    expect(spec?.declared).toEqual([]);
    expect(spec?.consumed.map((s) => s.file)).toEqual(['src/a.spec.ts']);
  });
});

describe('grep lock', () => {
  test('no gate-plane code selects a user glob list through the raw OR primitive', () => {
    const repo = resolve(import.meta.dir, '..', '..', '..', '..');
    const dirs = [
      'packages/boundaries/src/wiring',
      'packages/boundaries/src/policy',
      'packages/boundaries/src/baseline',
      'packages/boundaries/src/generated',
      'packages/boundaries/src/extract',
      'packages/cli/src/gates',
    ];
    const files = [
      'packages/inspector/src/doc-references.ts',
      // A knowledge `count` source's changed-files touch test: the count is
      // measured through `inspectSource`, so its footprint is the same scope.
      'packages/inspector/src/knowledge-stale.ts',
      'packages/cli/src/commands/baseline.command.ts',
      'packages/cli/src/commands/generated.command.ts',
    ];
    const offenders: string[] = [];
    const scan = (p: string): void => {
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/\bmatchesAny\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${relative(repo, p)}:${i + 1}`);
        });
    };
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.ts')) scan(p);
      }
    };
    for (const d of dirs) walk(join(repo, d));
    for (const f of files) scan(join(repo, f));
    expect(offenders).toEqual([]);
  });
});
