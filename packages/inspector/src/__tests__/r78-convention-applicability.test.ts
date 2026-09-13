/**
 * r78 — round 15 (15.1): THE convention applicability authority, in process.
 *
 * `conventionApplicability(convention, inspection, file?)` is the one answer
 * to "does this convention apply here?" — `conventions check`, the rule-graph
 * bridge, MCP `prepare_agent_task` and the list/get display all read it.
 * Semantics (the pack-compatibility precedent): any-of within a filter, AND
 * across filters, an absent or empty filter imposes nothing; `profileIds` /
 * `frameworks` are decided per workspace, `languages` / `fileGlobs` per file,
 * `constructKinds` is reserved.
 *
 * Real projects on disk, the real loaders and registries (`inspectSharkcraft`
 * → `listConventions`) — no hand-built inspection.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConventionAppliesToFilter, type IConvention } from '@shrkcrft/plugin-api';
import { WorkspaceProfile } from '@shrkcrft/workspace';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';
import { conventionApplicability, conventionScope } from '../convention-applicability.ts';
import { ConventionFilterLevel } from '../convention-filter-level.ts';
import { checkConventionsAgainstFiles, listConventions, loadConventions } from '../convention-registry.ts';
import { buildSelfConfigDoctorReportV2, SelfConfigSeverityV2 } from '../self-config-doctor-v2.ts';
import { prepareAgentTask } from '../agent-task-prep.ts';
import { fileLanguageIds, fileLanguageOf } from '../file-languages.ts';
import { buildRepositoryStats } from '../repository-stats.ts';

const TIMEOUT_MS = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const RULES = [{ id: 'any', description: 'hit every covered file', forbidMatch: '.' }];
const conv = (id: string, appliesTo?: Record<string, readonly string[]>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: id,
  kind: 'naming',
  severity: 'warning',
  rules: RULES,
  ...(appliesTo ? { appliesTo } : {}),
  ...extra,
});

/** A TypeScript project (tsconfig → `has-typescript` + framework `typescript` detected). */
function project(conventions: readonly Record<string, unknown>[], files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-applicability-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'tsconfig.json': '{}',
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx' };\n",
    'sharkcraft/conventions.ts': `export default ${JSON.stringify(conventions, null, 2)};\n`,
    'src/a.ts': 'export const a = 1;\n',
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

async function loaded(root: string): Promise<{ insp: ISharkcraftInspection; get: (id: string) => IConvention }> {
  const insp = await inspectSharkcraft({ cwd: root });
  const entries = await listConventions(insp);
  return {
    insp,
    get: (id) => {
      const e = entries.find((x) => x.convention.id === id);
      if (!e) throw new Error(`convention ${id} did not load`);
      return e.convention;
    },
  };
}

describe('the semantics table — workspace filters', () => {
  test(
    'any-of within a filter, AND across filters, absent / empty impose nothing, constructKinds reserved',
    async () => {
      const { insp, get } = await loaded(
        project([
          conv('p.any', { profileIds: ['has-turborepo', 'has-typescript'] }),
          conv('p.undetected', { profileIds: ['has-turborepo'] }),
          conv('p.and', { profileIds: ['has-typescript'], frameworks: ['angular'] }),
          conv('p.fw', { frameworks: ['typescript'] }),
          conv('p.none'),
          conv('p.empty', { profileIds: [] }),
          conv('p.ck', { constructKinds: ['component'] }),
        ]),
      );
      expect(insp.workspace.profiles).toContain(WorkspaceProfile.HasTypeScript);
      expect(insp.workspace.profiles).not.toContain(WorkspaceProfile.HasTurborepo);
      const verdict = (id: string) => conventionApplicability(get(id), insp);

      expect(verdict('p.any')).toMatchObject({ applicable: true, reasons: [{ filter: 'profileIds', matched: true, message: 'appliesTo.profileIds [has-turborepo, has-typescript]: detected has-typescript' }] });
      const undetected = verdict('p.undetected');
      expect(undetected.applicable).toBe(false);
      expect(undetected.reasons[0]).toMatchObject({ filter: 'profileIds', level: ConventionFilterLevel.Workspace, declared: ['has-turborepo'], matched: false });
      expect(undetected.reasons[0]!.message).toStartWith('appliesTo.profileIds [has-turborepo]: none detected (detected: ');
      const and = verdict('p.and');
      expect(and.applicable).toBe(false);
      expect(and.reasons.map((r) => [r.filter, r.matched])).toEqual([
        [ConventionAppliesToFilter.ProfileIds, true],
        [ConventionAppliesToFilter.Frameworks, false],
      ]);
      expect(verdict('p.fw')).toMatchObject({ applicable: true, reasons: [{ filter: 'frameworks', matched: true }] });
      expect(verdict('p.none')).toEqual({ applicable: true, reasons: [] });
      expect(verdict('p.empty')).toEqual({ applicable: true, reasons: [] });
      expect(verdict('p.ck')).toMatchObject({
        applicable: true,
        reasons: [{ filter: 'constructKinds', level: ConventionFilterLevel.Reserved, matched: true }],
      });
    },
    TIMEOUT_MS,
  );
});

describe('the semantics table — per-file filters', () => {
  test(
    'fileGlobs through the boundaries matcher (`**` spans zero segments, `!` subtracts, `?` never crosses `/`); languages through THE table',
    async () => {
      const root = project([
        conv('g.src', { fileGlobs: ['src/**/*.ts'] }),
        conv('g.all', { fileGlobs: ['**/*.ts'] }),
        conv('g.neg', { fileGlobs: ['src/**', '!src/b.ts'] }),
        conv('g.q', { fileGlobs: ['src/a?b.ts'] }),
        conv('l.ts', { languages: ['typescript'] }),
        conv('l.make', { languages: ['makefile'] }),
      ]);
      const { insp, get } = await loaded(root);
      const on = (id: string, file: string): boolean => conventionApplicability(get(id), insp, file).applicable;
      expect(on('g.src', 'src/a.ts')).toBe(true); // the direct child the private matcher missed
      expect(on('g.src', 'src/deep/d.ts')).toBe(true);
      expect(on('g.src', 'root.ts')).toBe(false);
      expect(on('g.src', './src/a.ts')).toBe(true); // normalized
      expect(on('g.src', join(root, 'src/a.ts'))).toBe(true); // absolute → project-relative
      expect(on('g.all', 'root.ts')).toBe(true);
      expect(on('g.neg', 'src/a.ts')).toBe(true);
      expect(on('g.neg', 'src/b.ts')).toBe(false);
      expect(on('g.q', 'src/axb.ts')).toBe(true);
      expect(on('g.q', 'src/a/b.ts')).toBe(false);
      expect(on('l.ts', 'src/a.tsx')).toBe(true);
      expect(on('l.ts', 'src/a.py')).toBe(false);
      expect(on('l.ts', 'README')).toBe(false);
      expect(on('l.make', 'Makefile')).toBe(true);
      // Without a file only the workspace decides; per-file filters are listed as such.
      expect(conventionApplicability(get('g.src'), insp)).toMatchObject({
        applicable: true,
        reasons: [{ filter: 'fileGlobs', level: ConventionFilterLevel.File, matched: true, message: 'appliesTo.fileGlobs [src/**/*.ts]: decided per file' }],
      });
    },
    TIMEOUT_MS,
  );

  test(
    'conventionScope: no file passing → not applicable, each per-file filter counting what it selected; an empty list stays applicable',
    async () => {
      const { insp, get } = await loaded(
        project([
          conv('s.lib', { fileGlobs: ['lib/**'], languages: ['python'] }),
          conv('s.mix', { fileGlobs: ['src/**'], languages: ['python'] }),
        ]),
      );
      const scope = conventionScope(get('s.lib'), insp, ['src/a.ts', 'src/b.ts', 'lib/x.ts']);
      expect(scope.applicable).toBe(false);
      expect(scope.files).toEqual([]);
      expect(scope.reasons.map((r) => r.message)).toEqual([
        'appliesTo.languages [python]: 0 of 3 file(s) in scope are a listed language (seen: typescript)',
        'appliesTo.fileGlobs [lib/**]: selects 1 of 3 file(s) in scope',
      ]);
      // Round 15 review: only the filter that EXCLUDED it is unmatched — `fileGlobs`
      // selected lib/x.ts, so it is not an excluding reason (it read as one).
      expect(scope.reasons.map((r) => [r.filter, r.matched])).toEqual([
        [ConventionAppliesToFilter.Languages, false],
        [ConventionAppliesToFilter.FileGlobs, true],
      ]);
      expect(conventionScope(get('s.lib'), insp, [])).toMatchObject({ applicable: true, files: [] });

      // Each per-file filter admits a file, no file passes both: the INTERSECTION
      // excluded it — both unmatched, and each says so (never an empty reason list).
      const disjoint = conventionScope(get('s.mix'), insp, ['src/a.ts', 'lib/b.py']);
      expect(disjoint.applicable).toBe(false);
      expect(disjoint.reasons.map((r) => [r.filter, r.matched, r.message])).toEqual([
        [
          ConventionAppliesToFilter.Languages,
          false,
          'appliesTo.languages [python]: 1 of 2 file(s) in scope is a listed language (seen: python, typescript) — but no file in scope passes every per-file filter together',
        ],
        [
          ConventionAppliesToFilter.FileGlobs,
          false,
          'appliesTo.fileGlobs [src/**]: selects 1 of 2 file(s) in scope — but no file in scope passes every per-file filter together',
        ],
      ]);

      // …and `conventions check` carries exactly the excluding reasons.
      const report = await checkConventionsAgainstFiles(insp, ['src/a.ts']);
      expect(report.notApplicable.map((n) => [n.conventionId, n.reasons.map((r) => r.filter)])).toEqual([
        ['s.lib', [ConventionAppliesToFilter.Languages, ConventionAppliesToFilter.FileGlobs]],
        ['s.mix', [ConventionAppliesToFilter.Languages]],
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    'checkConventionsAgainstFiles reads ONE spelling per file: the scope and every rule pattern test the project-relative path, and a hit names it',
    async () => {
      const root = project([
        conv('n.src', { fileGlobs: ['src/**'] }, { severity: 'error', rules: [{ id: 'under-src', description: 'under src/', filePattern: '^src/' }] }),
        conv('n.nots', { fileGlobs: ['src/**'] }, { severity: 'error', rules: [{ id: 'no-ts', description: 'no ts', forbidMatch: '\\.ts$' }] }),
      ]);
      const { insp } = await loaded(root);
      // `./src/a.ts` and the absolute path were covered by `src/**` (normalized)
      // and then tested raw against `^src/` — a false `n.src` hit.
      for (const spelling of ['./src/a.ts', join(insp.projectRoot, 'src/a.ts'), 'src/a.ts']) {
        const report = await checkConventionsAgainstFiles(insp, [spelling]);
        expect({ spelling, hits: report.hits.map((h) => `${h.conventionId}:${h.file}`) }).toEqual({
          spelling,
          hits: ['n.nots:src/a.ts'],
        });
      }
    },
    TIMEOUT_MS,
  );
});

describe('the engine and the loader', () => {
  test(
    'checkConventionsAgainstFiles: a not-applicable convention is never evaluated and carries its excluding reasons; expectMatch is evaluated',
    async () => {
      const { insp } = await loaded(
        project([
          conv('e.turbo', { profileIds: ['has-turborepo'] }),
          conv('e.expect', undefined, { severity: 'error', rules: [{ id: 'under-src', description: 'under src', expectMatch: '^src/' }] }),
        ]),
      );
      const report = await checkConventionsAgainstFiles(insp, ['src/a.ts', 'lib/x.ts']);
      expect(report.notApplicable).toEqual([
        expect.objectContaining({
          conventionId: 'e.turbo',
          sourceFile: 'sharkcraft/conventions.ts',
          reasons: [expect.objectContaining({ filter: 'profileIds', matched: false })],
        }),
      ]);
      expect(report.hits.map((h) => `${h.conventionId}:${h.file}`)).toEqual(['e.expect:lib/x.ts']);
      expect(report.filesInScope).toEqual({ 'e.expect': 2 });
      expect(report.verdict).toBe('has-violations');
    },
    TIMEOUT_MS,
  );

  test(
    'the loader REJECTS an unknown appliesTo key through the round-12 channel (did-you-mean), and loads constructKinds with the reserved warning',
    async () => {
      const insp = await inspectSharkcraft({
        cwd: project([conv('k.typo', { profileId: ['has-typescript'] }), conv('k.ck', { constructKinds: ['component'] })]),
      });
      const { entries, rejected, issues } = await loadConventions(insp);
      expect(entries.map((e) => e.convention.id)).toEqual(['k.ck']);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.entryId).toBe('k.typo');
      expect(rejected[0]!.reasons.join('\n')).toContain('did you mean "profileIds"?');
      expect(issues.filter((i) => i.code === 'convention-shape').map((i) => [i.conventionId, i.message])).toEqual([
        ['k.ck', 'appliesTo.constructKinds: appliesTo.constructKinds is reserved and not evaluated — the convention applies regardless'],
      ]);
    },
    TIMEOUT_MS,
  );
});

describe('the self-config doctor and prepare_agent_task read the same vocabularies / authority', () => {
  test(
    'a framework / language id outside THE vocabulary is an info *-missing finding with a did-you-mean; a fully examined coverage record has no empty-registry reason',
    async () => {
      const report = await buildSelfConfigDoctorReportV2(
        await inspectSharkcraft({
          cwd: project([
            conv('d.fw', { frameworks: ['next', 'react'] }),
            conv('d.lang', { languages: ['ts', 'typescript'] }),
            conv('d.prof', { profileIds: ['has-typescript'] }),
          ]),
        }),
      );
      const missing = report.findings
        .filter((f) => f.code === 'convention-framework-missing' || f.code === 'convention-language-missing')
        .map((f) => ({ code: f.code, sourceId: f.sourceId, targetKind: f.targetKind, targetId: f.targetId, severity: f.severity, fix: f.suggestedFix }));
      expect(missing).toEqual([
        { code: 'convention-framework-missing', sourceId: 'd.fw', targetKind: 'framework', targetId: 'next', severity: SelfConfigSeverityV2.Info, fix: 'Did you mean "nextjs"?' },
        { code: 'convention-language-missing', sourceId: 'd.lang', targetKind: 'language', targetId: 'ts', severity: SelfConfigSeverityV2.Info, fix: 'Did you mean "typescript"?' },
      ]);
      expect(report.findings.filter((f) => f.code === 'convention-profile-missing')).toEqual([]);
      const cov = report.coverage.find((c) => c.subject === 'conventions' && c.unit === 'applicability profile ids');
      expect(cov).toMatchObject({ expected: 1, examined: 1 });
      expect(cov!.reason).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  test(
    'prepare_agent_task hands the agent only conventions that apply to this workspace',
    async () => {
      const insp = await inspectSharkcraft({
        cwd: project([conv('a.turbo', { profileIds: ['has-turborepo'] }), conv('a.ts', { profileIds: ['has-typescript'] }), conv('a.any')]),
      });
      const prep = await prepareAgentTask(insp, 'rename a helper');
      expect(prep.relevantConventions.map((c) => c.id)).toEqual(['a.ts', 'a.any']);
    },
    TIMEOUT_MS,
  );
});

describe('ONE per-file language table', () => {
  test('`shrk stats` classifies with THE table `appliesTo.languages` reads', async () => {
    const root = project([], { 'src/b.py': 'x = 1\n', 'Makefile': 'all:\n', 'docs/r.md': '# r\n' });
    const stats = await buildRepositoryStats({ cwd: root, maxTopFiles: 50 });
    const ids = new Set(fileLanguageIds());
    expect(stats.byLanguage.length).toBeGreaterThan(2);
    for (const l of stats.byLanguage) expect({ language: l.language, known: ids.has(l.language) }).toEqual({ language: l.language, known: true });
    for (const f of stats.topFiles) expect({ path: f.path, language: f.language }).toEqual({ path: f.path, language: fileLanguageOf(f.path)!.id });
  }, TIMEOUT_MS);
});
