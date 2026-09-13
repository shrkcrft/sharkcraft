/**
 * r77 — intended-empty ASSET units (round 13, lane A; DECISIONS §4 assets,
 * DESIGN-D1 tests item 7). Real loaders over temp workspaces, in-process:
 *
 *   - registration hints (`discovery.targetGlobs` / `discovery.targetFile`),
 *     scaffold patterns (`matchPaths`) and search tuning (`boostIds` /
 *     `taskHints[].boostIds`) accept `{ pattern | weight, expectEmpty: true }`
 *     markers: the loader normalises them to the plain value plus an
 *     `expectEmptyUnits` ledger, and THE settle reads the unit intended-empty
 *     (an `acceptedBy: expectEmpty` record — accepted at exit 0) or, once its
 *     target exists, went-live (reported; `--fail-on-dead-units` fails it);
 *   - scaffold patterns: ONE planned fact is ONE acceptance (the derived
 *     pattern-level unit is not a second dead unit);
 *   - search tuning: a marker VALUE keeps its weight — never clamped to 0 — and
 *     a non-number, non-marker value is REFUSED, never clamped;
 *   - every malformed marker is refused LOUDLY through the round-12 rejection
 *     channel (the loader's predicate ≡ `validateContributionFile`), never a
 *     crash (`glob.includes is not a function`) or an `[object Object]` glob;
 *   - the self-config doctor carries the families' acceptances and states.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { settleVerdict, UnitLivenessState } from '@shrkcrft/core';
import { assetDoctorProposedExit } from '../asset-doctor-proposed-exit.ts';
import { RegistrationHintDiscoveryStatus } from '../registration-hint-discovery-status.ts';
import {
  buildRegistrationHintDoctorReport,
  loadRegistrationHints,
  registrationHintRejectionReasons,
} from '../registration-hint-registry.ts';
import { buildScaffoldPatternDoctorReport } from '../scaffold-pattern-doctor-report.ts';
import { loadScaffoldPatternsFromInspection, scaffoldPatternRejectionReasons } from '../scaffold-patterns.ts';
import { lintSearchTuning } from '../search-tuning-lint.ts';
import { loadSearchTuning, searchTuningRejectionReasons } from '../search-tuning-registry.ts';
import { buildSelfConfigDoctorReportV2, collectUnresolvableReferences } from '../self-config-doctor-v2.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import { validateContributionFile } from '../validate-contribution-file.ts';

const TIMEOUT_MS = 60_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/**
 * A temp workspace. Defaults to one registered knowledge entry (so a boost key
 * resolves Missing, not Unverified); `withKnowledge: false` leaves the knowledge
 * registry EMPTY (no `sharkcraft/knowledge.ts` — it loads by convention).
 * A module is imported once per process, so a "later" state is its own workspace.
 */
function workspace(files: Readonly<Record<string, string>>, withKnowledge = true): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r77-assets-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'sharkcraft/sharkcraft.config.ts': withKnowledge
      ? "export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n"
      : "export default { projectName: 'fx' };\n",
    ...(withKnowledge ? { 'sharkcraft/knowledge.ts': knowledge(['fx.other']) } : {}),
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) write(root, rel, body);
  return root;
}

function knowledge(ids: readonly string[]): string {
  return `export default [${ids
    .map((id) => `{ id: '${id}', title: '${id}', type: 'architecture', priority: 'high', tags: [], content: 'About ${id}.' }`)
    .join(', ')}];\n`;
}

const hint = (id: string, discovery: string): string =>
  `{ id: '${id}', title: '${id}', discovery: ${discovery}, operations: [{ kind: 'append', snippet: 'x' }] }`;

const pattern = (id: string, matchPaths: string): string =>
  `{ id: '${id}', title: '${id}', description: 'd', templateId: 'fx.none', matchPaths: ${matchPaths}, variables: [], appliesWhen: ['infer-template'], confidence: 'high' }`;

describe('r77 registration hints — discovery.targetGlobs / discovery.targetFile', () => {
  test(
    'a marker loads as its plain unit plus a ledger, and settles intended-empty — accepted, never dead',
    async () => {
      const root = workspace({
        // The discovery dialect's `**/` needs a directory between (its own `src/live/**/*.ts`).
        'src/live/x/a.ts': 'export {};\n',
        'sharkcraft/registration-hints.ts': `export default [${hint(
          'fx.globs',
          "{ targetGlobs: ['src/live/**/*.ts', { pattern: 'src/plugins/**/registry.ts', expectEmpty: true, reason: 'plugins land in v2' }] }",
        )}, ${hint('fx.file', "{ targetFile: { pattern: 'src/app/routes.ts', expectEmpty: true } }")}];\n`,
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const { entries, rejected } = await loadRegistrationHints(inspection);
      expect(rejected).toEqual([]);
      const globs = entries.find((e) => e.hint.id === 'fx.globs')!.hint;
      expect(globs.discovery.targetGlobs).toEqual(['src/live/**/*.ts', 'src/plugins/**/registry.ts']);
      expect(globs.expectEmptyUnits).toEqual([
        { list: 'discovery.targetGlobs', unit: 'src/plugins/**/registry.ts', reason: 'plugins land in v2' },
      ]);
      const file = entries.find((e) => e.hint.id === 'fx.file')!.hint;
      expect(file.discovery.targetFile).toBe('src/app/routes.ts');

      const report = await buildRegistrationHintDoctorReport(inspection);
      expect(report.deadUnits).toEqual([]);
      expect(Object.fromEntries(report.hints.map((h) => [h.id, h.status]))).toEqual({
        'fx.globs': RegistrationHintDiscoveryStatus.Verified,
        'fx.file': RegistrationHintDiscoveryStatus.IntendedEmpty,
      });
      expect(report.totals.intendedEmpty).toBe(1);
      const codes = report.issues.map((i) => i.code);
      expect(codes.filter((c) => c === 'discovery-intended-empty')).toHaveLength(2);
      expect(codes).not.toContain('discovery-glob-matched-nothing');
      expect(codes).not.toContain('target-file-missing');
      const settled = settleVerdict(0, report.coverage);
      expect(settled.exit).toBe(0);
      expect(settled.accepted).toHaveLength(1);
      expect(settled.accepted[0]).toContain('accepted by expectEmpty');
      expect(settled.accepted[0]).toContain('fx.globs: src/plugins/**/registry.ts');
      expect(settled.accepted[0]).toContain('fx.file: src/app/routes.ts');

      // The targets appear: went-live — reported, no acceptance, and a stale LOCAL
      // marker fails under --fail-on-dead-units (never through --strict alone).
      write(root, 'src/plugins/a/registry.ts', 'export {};\n');
      write(root, 'src/app/routes.ts', 'export {};\n');
      const live = await buildRegistrationHintDoctorReport(await inspectSharkcraft({ cwd: root }));
      expect(live.liveness.wentLive.map((u) => u.unit).sort()).toEqual(['src/app/routes.ts', 'src/plugins/**/registry.ts']);
      expect(live.issues.map((i) => i.code).filter((c) => c === 'discovery-went-live')).toHaveLength(2);
      expect(settleVerdict(0, live.coverage)).toEqual({ exit: 0, verdict: 'pass', shortfalls: [], accepted: [] });
      const found = { errors: 0, warnings: 0, units: live.liveness.units };
      expect(assetDoctorProposedExit(found, { strict: false, failOnDeadUnits: true })).toBe(1);
      expect(assetDoctorProposedExit(found, { strict: true, failOnDeadUnits: false })).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    'a malformed marker is REFUSED loudly (the loader predicate ≡ packs test --load) — never a crash',
    async () => {
      const bad = {
        id: 'fx.bad',
        title: 'Bad',
        discovery: { targetGlobs: [{ glob: 'src/x/**', expectEmpty: true }, 42] },
        operations: [{ kind: 'append', snippet: 'x' }],
      };
      const reasons = registrationHintRejectionReasons(bad);
      expect(reasons[0]).toStartWith('discovery.targetGlobs[0]: a marker naming no unit');
      expect(reasons[1]).toBe('discovery.targetGlobs[1]: must be a string or { pattern, expectEmpty: true, reason? } (got 42)');
      expect(
        registrationHintRejectionReasons({ ...bad, discovery: { targetFile: { pattern: 'src/x.ts' } } }),
      ).toEqual(['discovery.targetFile: an object entry must set expectEmpty: true — write the plain string otherwise']);
      expect(
        registrationHintRejectionReasons({ ...bad, discovery: { targetFile: 'src/x.ts' }, expectEmptyUnits: [] })[0],
      ).toStartWith('expectEmptyUnits: expectEmptyUnits is derived by the loader');

      const root = workspace({
        'sharkcraft/registration-hints.ts': `export default [${hint('fx.bad', "{ targetGlobs: [{ glob: 'src/x/**', expectEmpty: true }] }")}];\n`,
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const loaded = await loadRegistrationHints(inspection);
      expect(loaded.entries).toEqual([]);
      expect(loaded.rejected).toHaveLength(1);
      expect(loaded.rejected[0]!.reasons[0]).toStartWith('discovery.targetGlobs[0]: a marker naming no unit');
      // The doctor names the rejection instead of crashing on `glob.includes`.
      const report = await buildRegistrationHintDoctorReport(inspection);
      expect(report.issues.map((i) => i.code)).toContain('invalid-hint');
      const build = await validateContributionFile('registrationHintFiles', join(root, 'sharkcraft/registration-hints.ts'));
      expect(build.rejected.map((r) => r.reasons)).toEqual(loaded.rejected.map((r) => r.reasons));
    },
    TIMEOUT_MS,
  );

  test(
    'a marker on targetGlobs beside a fixed targetFile is REFUSED at load — that list is never judged, so it would vanish (K4)',
    async () => {
      const both = {
        id: 'fx.both',
        title: 'Both',
        discovery: {
          targetFile: 'src/app/routes.ts',
          targetGlobs: ['src/live/**/*.ts', { pattern: 'src/plugins/**/registry.ts', expectEmpty: true }],
        },
        operations: [{ kind: 'append', snippet: 'x' }],
      };
      expect(registrationHintRejectionReasons(both)).toEqual([
        "discovery.targetGlobs[1]: a marker on a list this hint's discovery mode never judges — a fixed discovery.targetFile wins over discovery.targetGlobs, so 'src/plugins/**/registry.ts' is never read; mark discovery.targetFile instead, or drop targetFile so the globs are judged",
      ]);
      // The judged list may carry the marker, and plain globs beside a fixed target stay legal.
      expect(
        registrationHintRejectionReasons({
          ...both,
          discovery: { targetFile: { pattern: 'src/app/routes.ts', expectEmpty: true }, targetGlobs: ['src/live/**/*.ts'] },
        }),
      ).toEqual([]);
      // Without the fixed target the same marker is judged — and accepted.
      expect(
        registrationHintRejectionReasons({ ...both, discovery: { targetGlobs: both.discovery.targetGlobs } }),
      ).toEqual([]);

      // Both surfaces read the one predicate: the doctor (loader rejection →
      // `invalid-hint`) and `packs test --load` (`validateContributionFile`).
      const root = workspace({
        'sharkcraft/registration-hints.ts': `export default [${hint(
          'fx.both',
          "{ targetFile: 'src/app/routes.ts', targetGlobs: [{ pattern: 'src/plugins/**/registry.ts', expectEmpty: true }] }",
        )}];\n`,
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const loaded = await loadRegistrationHints(inspection);
      expect(loaded.entries).toEqual([]);
      expect(loaded.rejected).toHaveLength(1);
      expect(loaded.rejected[0]!.reasons).toEqual([
        "discovery.targetGlobs[0]: a marker on a list this hint's discovery mode never judges — a fixed discovery.targetFile wins over discovery.targetGlobs, so 'src/plugins/**/registry.ts' is never read; mark discovery.targetFile instead, or drop targetFile so the globs are judged",
      ]);
      const report = await buildRegistrationHintDoctorReport(inspection);
      expect(report.issues.filter((i) => i.code === 'invalid-hint').map((i) => `${i.severity}: ${i.message}`)).toEqual(
        loaded.rejected[0]!.reasons.map((r) => `error: ${r}`),
      );
      const build = await validateContributionFile('registrationHintFiles', join(root, 'sharkcraft/registration-hints.ts'));
      expect(build.rejected.map((r) => r.reasons)).toEqual(loaded.rejected.map((r) => r.reasons));
    },
    TIMEOUT_MS,
  );
});

describe('r77 scaffold patterns — matchPaths', () => {
  test(
    'ONE planned fact is ONE acceptance — never the dead=2 of glob + derived pattern',
    async () => {
      const root = workspace({
        'sharkcraft/scaffold-patterns.ts': `export default [${pattern('fx.plugin', "[{ pattern: 'src/plugins/*/plugin.ts', expectEmpty: true }]")}];\n`,
      });
      const inspection = await inspectSharkcraft({ cwd: root });
      const loaded = await loadScaffoldPatternsFromInspection(inspection);
      const p = loaded.patterns[0]!.pattern;
      expect(p.matchPaths).toEqual(['src/plugins/*/plugin.ts']);
      expect(p.expectEmptyUnits).toEqual([{ list: 'matchPaths', unit: 'src/plugins/*/plugin.ts' }]);

      const report = await buildScaffoldPatternDoctorReport(inspection);
      expect(report.measured.deadUnits).toEqual([]);
      expect(report.issues.map((i) => i.code)).toContain('matchPaths-intended-empty');
      expect(report.issues.map((i) => i.code)).not.toContain('pattern-dead');
      const settled = settleVerdict(0, report.coverage);
      expect(settled.exit).toBe(0);
      expect(settled.accepted).toHaveLength(1);
      expect(settled.accepted[0]).toContain('accepted by expectEmpty: examined 0 of 1 matchPaths globs');

      write(root, 'src/plugins/a/plugin.ts', 'export {};\n');
      const live = await buildScaffoldPatternDoctorReport(await inspectSharkcraft({ cwd: root }));
      const units = live.measured.liveness.flatMap((s) => s.units);
      expect(units.filter((u) => u.state === UnitLivenessState.WentLive).map((u) => u.unit)).toEqual(['src/plugins/*/plugin.ts']);
      expect(settleVerdict(0, live.coverage).accepted).toEqual([]);
      expect(assetDoctorProposedExit({ errors: 0, warnings: 0, units }, { strict: false, failOnDeadUnits: true })).toBe(1);
    },
    TIMEOUT_MS,
  );

  test(
    'a marked glob beside a dead sibling keeps the pattern judged: the dead glob and the pattern are both dead (2)',
    async () => {
      const root = workspace({
        'sharkcraft/scaffold-patterns.ts': `export default [${pattern(
          'fx.half',
          "[{ pattern: 'src/plugins/*/plugin.ts', expectEmpty: true }, 'src/retired/**/*.ts']",
        )}];\n`,
      });
      const report = await buildScaffoldPatternDoctorReport(await inspectSharkcraft({ cwd: root }));
      expect(report.measured.deadUnits).toEqual(['scaffold pattern fx.half: src/retired/**/*.ts', 'scaffold pattern fx.half (no file)']);
      expect(settleVerdict(0, report.coverage).exit).toBe(2);
    },
    TIMEOUT_MS,
  );

  test(
    'an object entry never loads as the glob `[object Object]`: a malformed marker is refused, at build time too',
    async () => {
      const reasons = scaffoldPatternRejectionReasons({
        id: 'fx.bad',
        templateId: 'fx.none',
        confidence: 'high',
        matchPaths: [{ glob: 'src/x/**', expectEmpty: true }],
      });
      expect(reasons[0]).toStartWith('matchPaths[0]: a marker naming no unit');
      // An authored ledger is refused: the loader derives `expectEmptyUnits` from the markers.
      const authored = 'expectEmptyUnits: derived by the loader — mark the entry itself: matchPaths: [{ pattern, expectEmpty: true }]';
      expect(
        scaffoldPatternRejectionReasons({ id: 'fx.p', templateId: 'fx.none', confidence: 'high', matchPaths: ['src/**'], expectEmptyUnits: [] }),
      ).toContain(authored);
      expect(scaffoldPatternRejectionReasons({ id: 'fx.p', templateId: 'fx.none', confidence: 'high', matchPaths: ['src/**'] })).toEqual([]);
      const ledgerRoot = workspace({
        'sharkcraft/scaffold-patterns.ts': `export default [{ id: 'fx.ledger', title: 'l', description: 'd', templateId: 'fx.none', matchPaths: ['src/**'], variables: [], appliesWhen: ['infer-template'], confidence: 'high', expectEmptyUnits: [{ list: 'matchPaths', unit: 'src/**' }] }];\n`,
      });
      const ledger = await buildScaffoldPatternDoctorReport(await inspectSharkcraft({ cwd: ledgerRoot }));
      expect(ledger.patterns).toEqual([]);
      expect(ledger.rejected.map((r) => r.reasons)).toEqual([[authored]]);
      const root = workspace({
        'sharkcraft/scaffold-patterns.ts': `export default [${pattern('fx.bad', "[{ pattern: 'src/x/**', expectEmpty: 'yes' }]")}];\n`,
      });
      const report = await buildScaffoldPatternDoctorReport(await inspectSharkcraft({ cwd: root }));
      expect(report.patterns).toEqual([]);
      expect(report.rejected).toHaveLength(1);
      expect(report.rejected[0]!.reasons).toEqual([
        'matchPaths[0]: expectEmpty must be the literal true (got "yes") — write the plain string otherwise',
      ]);
      expect(report.errors).toBe(1);
      const build = await validateContributionFile('scaffoldPatternFiles', join(root, 'sharkcraft/scaffold-patterns.ts'));
      expect(build.rejected.map((r) => r.reasons)).toEqual(report.rejected.map((r) => r.reasons));
    },
    TIMEOUT_MS,
  );
});

describe('r77 search tuning — boostIds / taskHints[].boostIds', () => {
  test(
    'a { weight, expectEmpty } value keeps its weight (never clamped to 0) and settles intended-empty',
    async () => {
      const tuning = `export default [{ id: 'fx.t', boostIds: { 'knowledge:fx.guide': { weight: 3, expectEmpty: true, reason: 'next sprint' } }, taskHints: [{ whenTokens: ['guide'], boostIds: { 'knowledge:fx.guide': { weight: 2, expectEmpty: true } } }] }];\n`;
      const root = workspace({ 'sharkcraft/search-tuning.ts': tuning });
      const inspection = await inspectSharkcraft({ cwd: root });
      const loaded = await loadSearchTuning(inspection);
      expect(loaded.rejected).toEqual([]);
      const e = loaded.entries[0]!;
      expect(e.boostIds).toEqual({ 'knowledge:fx.guide': 3 });
      expect(e.taskHints?.[0]?.boostIds).toEqual({ 'knowledge:fx.guide': 2 });
      expect(e.expectEmptyUnits).toEqual([
        { list: 'boostIds', unit: 'knowledge:fx.guide', reason: 'next sprint' },
        { list: 'taskHints[0].boostIds', unit: 'knowledge:fx.guide' },
      ]);
      expect(loaded.issues.map((i) => i.code)).not.toContain('boost-clamped');

      const lint = await lintSearchTuning(inspection);
      expect(lint.deadUnits).toEqual([]);
      expect(lint.issues.map((i) => i.code)).toContain('target-intended-empty');
      const settled = settleVerdict(0, lint.coverage);
      expect(settled.exit).toBe(0);
      expect(settled.accepted.join('\n')).toContain('accepted by expectEmpty: examined 0 of 1 boost keys');

      // The target registered: the same tuning over a workspace where the guide exists.
      const liveRoot = workspace({
        'sharkcraft/search-tuning.ts': tuning,
        'sharkcraft/knowledge.ts': knowledge(['fx.other', 'fx.guide']),
      });
      const live = await lintSearchTuning(await inspectSharkcraft({ cwd: liveRoot }));
      const units = live.liveness.flatMap((s) => s.units);
      expect(units.find((u) => u.unit === 'knowledge:fx.guide')?.state).toBe(UnitLivenessState.WentLive);
      expect(live.issues.map((i) => i.code)).toContain('expect-empty-went-live');
      expect(assetDoctorProposedExit({ errors: 0, warnings: 0, units }, { strict: false, failOnDeadUnits: true })).toBe(1);
    },
    TIMEOUT_MS,
  );

  test('a non-number, non-marker boost value is REFUSED — never clamped to 0 — and so is a marker on a key that can never fire', () => {
    const reasons = searchTuningRejectionReasons({
      id: 'fx.t',
      boostIds: { 'knowledge:fx.guide': 'high', 'fx.bare': { weight: 1, expectEmpty: true } },
      boostTags: { alpha: { weight: 2, expectEmpty: true } },
    });
    expect(reasons).toContain('boostIds["knowledge:fx.guide"]: must be a number or { weight, expectEmpty: true, reason? } (got "high")');
    expect(reasons.some((r) => r.startsWith('boostTags["alpha"]: must be a number') && r.includes('accepted only in boostIds'))).toBe(true);
    // Only when the map parses is a marker judged for its key.
    const keyReasons = searchTuningRejectionReasons({ id: 'fx.t', boostIds: { 'fx.bare': { weight: 1, expectEmpty: true } } });
    expect(keyReasons[0]).toStartWith('boostIds["fx.bare"]: an expectEmpty marker on a key that can never fire');
    const excluded = searchTuningRejectionReasons({
      id: 'fx.t',
      appliesToKinds: ['rule'],
      boostIds: { 'knowledge:fx.guide': { weight: 1, expectEmpty: true } },
    });
    expect(excluded[0]).toContain("appliesToKinds [rule] excludes");
    expect(searchTuningRejectionReasons({ id: 'fx.t', boostIds: { 'knowledge:fx.guide': 2 } })).toEqual([]);
    // An authored ledger is refused: the loader derives `expectEmptyUnits` from the boost markers.
    expect(searchTuningRejectionReasons({ id: 'fx.t', boostIds: { 'knowledge:fx.guide': 2 }, expectEmptyUnits: [] })).toContain(
      "expectEmptyUnits: derived by the loader — mark the boost itself: boostIds: { '<kind>:<id>': { weight, expectEmpty: true } }",
    );
    // taskHints must be an array of objects whose whenTokens are strings.
    expect(searchTuningRejectionReasons({ id: 'fx.t', taskHints: 'guide' })).toContain('taskHints: must be an array (got "guide")');
    expect(searchTuningRejectionReasons({ id: 'fx.t', taskHints: [{ whenTokens: [7] }] })[0]).toStartWith(
      'taskHints[0].whenTokens: must be an array of strings',
    );
    expect(searchTuningRejectionReasons({ id: 'fx.t', taskHints: [{ whenTokens: ['guide'] }] })).toEqual([]);
  });

  test(
    'the loader refuses an authored ledger and a malformed taskHints entry through the rejection channel — never loaded silently',
    async () => {
      const root = workspace({
        'sharkcraft/search-tuning.ts': `export default [
  { id: 'fx.ledger', boostIds: { 'knowledge:fx.other': 2 }, expectEmptyUnits: [{ list: 'boostIds', unit: 'knowledge:fx.other' }] },
  { id: 'fx.hints', taskHints: 'guide' },
  { id: 'fx.tokens', taskHints: [{ whenTokens: [7], boostIds: { 'knowledge:fx.other': 1 } }] },
  { id: 'fx.ok', boostIds: { 'knowledge:fx.other': 1 } },
];\n`,
      });
      const loaded = await loadSearchTuning(await inspectSharkcraft({ cwd: root }));
      expect(loaded.entries.map((e) => e.id)).toEqual(['fx.ok']);
      expect(loaded.rejected.map((r) => r.entryId)).toEqual(['fx.ledger', 'fx.hints', 'fx.tokens']);
      const reasons = loaded.rejected.map((r) => r.reasons[0] ?? '');
      expect(reasons[0]).toStartWith('expectEmptyUnits: derived by the loader');
      expect(reasons[1]).toBe('taskHints: must be an array (got "guide")');
      expect(reasons[2]).toStartWith('taskHints[0].whenTokens: must be an array of strings');
      expect(loaded.issues.filter((i) => i.code === 'invalid-entry').every((i) => i.severity === 'error')).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    'the loader refuses such an entry through the rejection channel (an error), instead of loading a 0 boost',
    async () => {
      const root = workspace({
        'sharkcraft/search-tuning.ts': `export default [{ id: 'fx.t', boostIds: { 'knowledge:fx.other': 'high' } }];\n`,
      });
      const loaded = await loadSearchTuning(await inspectSharkcraft({ cwd: root }));
      expect(loaded.entries).toEqual([]);
      expect(loaded.rejected).toHaveLength(1);
      expect(loaded.rejected[0]!.entryId).toBe('fx.t');
      expect(loaded.issues.find((i) => i.code === 'invalid-entry')?.severity).toBe('error');
    },
    TIMEOUT_MS,
  );

  test(
    'a missing target declared twice, marked once, stays dead — an unmarked declaration still never fires',
    async () => {
      const root = workspace({
        'sharkcraft/search-tuning.ts': `export default [{ id: 'fx.a', boostIds: { 'knowledge:fx.guide': { weight: 1, expectEmpty: true } } }, { id: 'fx.b', boostIds: { 'knowledge:fx.guide': 1 } }];\n`,
      });
      const lint = await lintSearchTuning(await inspectSharkcraft({ cwd: root }));
      expect(lint.deadUnits).toEqual(['search-tuning key knowledge:fx.guide (missing)']);
      expect(settleVerdict(0, lint.coverage).exit).toBe(2);
      // The ignored marker is never silent: the MARKED declaration's finding says
      // why (the unmarked one), the unmarked declaration's finding does not.
      const finding = (id: string): string =>
        lint.issues.find((i) => i.tuningId === id && i.code === 'target-missing')?.message ?? '';
      expect(finding('fx.a')).toContain(
        'Its expectEmpty marker is not honoured: the key is also declared unmarked (fx.b boostIds)',
      );
      expect(finding('fx.b')).not.toContain('not honoured');
    },
    TIMEOUT_MS,
  );

  test(
    'a marker never accepts an UNVERIFIABLE key: with no knowledge registered the marked key stays unproven (2)',
    async () => {
      const root = workspace(
        { 'sharkcraft/search-tuning.ts': `export default [{ id: 'fx.t', boostIds: { 'knowledge:fx.guide': { weight: 1, expectEmpty: true } } }];\n` },
        false,
      );
      const inspection = await inspectSharkcraft({ cwd: root });
      const lint = await lintSearchTuning(inspection);
      expect(lint.liveness[0]!.units[0]!.state).toBe(UnitLivenessState.Unproven);
      expect(settleVerdict(0, lint.coverage).exit).toBe(2);
      // THE unresolvable-reference scan names the same key (`packs contributions` reads it).
      const scan = await collectUnresolvableReferences(inspection);
      expect(scan.references.filter((r) => r.sourceKind === 'search-tuning')).toEqual([
        expect.objectContaining({ sourceId: 'fx.t', field: 'boostIds', kind: 'knowledge', id: 'fx.guide', reason: 'registry-empty' }),
      ]);
      const doctor = await buildSelfConfigDoctorReportV2(inspection);
      expect(doctor.unresolvableReferences.filter((r) => r.sourceKind === 'search-tuning')).toEqual(
        scan.references.filter((r) => r.sourceKind === 'search-tuning'),
      );
    },
    TIMEOUT_MS,
  );
});

describe('r77 self-config doctor — the families\' acceptances and states', () => {
  test(
    'every family acceptance rides in coverage (so `accepted` prints it at exit 0), and selectorUnits carry the states',
    async () => {
      const root = workspace({
        'sharkcraft/registration-hints.ts': `export default [${hint('fx.hint', "{ targetGlobs: [{ pattern: 'src/plugins/**/registry.ts', expectEmpty: true }] }")}];\n`,
        'sharkcraft/scaffold-patterns.ts': `export default [${pattern('fx.plugin', "[{ pattern: 'src/plugins/*/plugin.ts', expectEmpty: true }]")}];\n`,
        'sharkcraft/search-tuning.ts': `export default [{ id: 'fx.t', boostIds: { 'knowledge:fx.guide': { weight: 3, expectEmpty: true } } }];\n`,
      });
      const report = await buildSelfConfigDoctorReportV2(await inspectSharkcraft({ cwd: root }));
      expect(report.deadUnits).toEqual([]);
      expect(report.selectorUnits.map((u) => u.state)).toEqual([
        UnitLivenessState.IntendedEmpty,
        UnitLivenessState.IntendedEmpty,
        UnitLivenessState.IntendedEmpty,
      ]);
      const acceptances = report.coverage.filter((c) => c.acceptedBy === 'expectEmpty').map((c) => c.subject);
      expect(acceptances.sort()).toEqual(['registration hints', 'scaffold patterns', 'search tuning']);
      // In-process there is no command resolver (the CLI injects one): leave the
      // command-string record out, and the asset families settle to an accepted 0.
      const assets = settleVerdict(0, report.coverage.filter((c) => c.unit !== 'command strings'));
      expect(assets.exit).toBe(0);
      expect(assets.accepted).toHaveLength(3);
      expect(report.verdict === 'unverified' ? report.coverage.some((c) => c.unit === 'command strings') : true).toBe(true);
    },
    TIMEOUT_MS,
  );
});
