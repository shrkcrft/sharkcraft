/**
 * Round 11 (integration lane) — items 4, 7, 8 and 13, through the real
 * inspector over real mkdtemp workspaces.
 *
 *   4. The quality report derives `overall` through ONE classification of its
 *      gates (`examineQualityGate`, the one `shrk quality` reads) and core's
 *      coverage rule. A gate that examined only part of its scope, or a
 *      required gate that examined nothing, is never `pass`.
 *   7. A playbook file that fails to import is a registry load failure, with
 *      exactly the severity a broken hint file gets (the async inventory's
 *      `invalid-contribution` conflict), not a softer "unverified" of its own.
 *   8. `area-explore` classifies through THE area classifier. A config pattern
 *      covering part of `libs/` no longer gives every `libs/…` path its kind,
 *      and a directory's kind has an explicit rule: the majority of its files.
 *  13. One authority each: changes-summary reads a boundary rule's scope
 *      through `boundaryRuleScope` (a `!` entry exempts, it is not a literal
 *      glob), and spec evidence decides "is this a test?" through
 *      `TEST_FILE_GLOBS`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exploreArea } from '../area-explore.ts';
import { AreaKind } from '../area-map.ts';
import { buildChangesSummary } from '../changes-summary.ts';
import { collectRegistryLoadFailures } from '../contribution-load-failures.ts';
import { buildPackContributionsInventoryAsync } from '../pack-contributions-inventory.ts';
import { QualityGateExamination } from '../quality-gate-examination.ts';
import { examineQualityGate } from '../quality-report-coverage.ts';
import { buildQualityReport } from '../quality-report.ts';
import { buildSelfConfigDoctorReportV2 } from '../self-config-doctor-v2.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';
import { mapChecklistToEvidence } from '../spec/spec-evidence.ts';

const TIMEOUT_MS = 90_000;
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(files: Record<string, string>, config = "export default { projectName: 'fx' };\n"): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-lane-insp-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  const all = { 'sharkcraft/sharkcraft.config.ts': config, ...files };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const WITH_BOUNDARIES = "export default { projectName: 'fx', boundaryFiles: ['boundaries.ts'] };\n";
/** A warning rule whose scope glob matches no file: `check boundaries` exits 2 over it. */
const DEAD_BOUNDARY =
  "export default [{ id: 'old.dead', title: 'Old', severity: 'warning', from: ['packages/old/**'], forbiddenImports: ['@scope/ui'] }];\n";

// ── 4. the quality report's overall ────────────────────────────────────────

describe('item 4 — a partial gate is never a passing quality report', () => {
  test('a boundary rule whose scope matched nothing: boundaries PARTIAL → overall not-verified, gate named', async () => {
    const root = workspace({ 'sharkcraft/boundaries.ts': DEAD_BOUNDARY, 'src/a.ts': 'export const A = 1;\n' }, WITH_BOUNDARIES);
    const report = await buildQualityReport({ inspection: await inspectSharkcraft({ cwd: root }), config: {} });
    const boundaries = report.gates.find((g) => g.id === 'boundaries')!;
    expect({ passed: boundaries.passed, partial: boundaries.data?.['partial'] }).toEqual({ passed: true, partial: true });
    expect({ overall: report.overall, blockers: report.blockers }).toEqual({ overall: 'not-verified', blockers: 0 });
    expect(report.coverage?.unexamined).toContain('boundaries');
    expect(report.shortfalls?.[0]).toContain('boundaries');
    // A partial gate keeps its repro, so the not-verified report says what to run.
    expect(report.nextRecommendations.join('\n')).toContain('shrk check boundaries');
  }, TIMEOUT_MS);

  test('ONE classification covers every gate: partial → unexamined, optional-and-empty → deliberate', async () => {
    const root = workspace({ 'sharkcraft/boundaries.ts': DEAD_BOUNDARY, 'src/a.ts': 'export const A = 1;\n' }, WITH_BOUNDARIES);
    const report = await buildQualityReport({ inspection: await inspectSharkcraft({ cwd: root }), config: {} });
    const exam = Object.fromEntries(report.gates.map((g) => [g.id, examineQualityGate(g)]));
    expect(exam['boundaries']).toBe(QualityGateExamination.Unexamined);
    expect(exam['doctor']).toBe(QualityGateExamination.Examined);
    expect(exam['context-tests']).toBe(QualityGateExamination.DeliberateSkip);
  }, TIMEOUT_MS);

  test('a REQUIRED gate that examined nothing is not-verified; the same gate optional is a deliberate skip', async () => {
    const root = workspace({ 'src/a.ts': 'export const A = 1;\n' });
    const inspection = await inspectSharkcraft({ cwd: root });
    const required = await buildQualityReport({ inspection, config: { requireBoundaryClean: true } });
    expect(required.overall).toBe('not-verified');
    expect(required.coverage?.unexamined).toContain('boundaries');
    const optional = await buildQualityReport({ inspection, config: {} });
    expect(['pass', 'warn']).toContain(optional.overall);
    expect(optional.shortfalls).toEqual([]);
  }, TIMEOUT_MS);
});

// ── 7. playbook load failures ──────────────────────────────────────────────

/** Two adjacent string literals inside an object: a hard syntax error. */
const BROKEN_PLAYBOOK = `export default [{ id: 'pb.broken' 'oops', title: 'Broken', steps: [] }];\n`;
const BROKEN_HINT = `export default [{ id: 'h.broken' 'x', title: 'B', match: {}, recommends: {} }];\n`;

describe('item 7 — a broken playbook file has a broken hint file\'s severity', () => {
  test('it is a registry load failure, an invalid-contribution conflict, and the doctor verdict matches the hint case', async () => {
    const pb = await inspectSharkcraft({ cwd: workspace({ 'sharkcraft/playbooks.ts': BROKEN_PLAYBOOK }) });
    const failures = await collectRegistryLoadFailures(pb);
    expect(failures.map((f) => [f.kind, f.file.endsWith('playbooks.ts')])).toContainEqual(['playbook', true]);
    const inventory = await buildPackContributionsInventoryAsync(pb);
    expect(inventory.conflicts.some((c) => c.kind === 'invalid-contribution')).toBe(true);

    const hint = await inspectSharkcraft({ cwd: workspace({ 'sharkcraft/task-routing-hints.ts': BROKEN_HINT }) });
    const [pbDoctor, hintDoctor] = await Promise.all([
      buildSelfConfigDoctorReportV2(pb),
      buildSelfConfigDoctorReportV2(hint),
    ]);
    const conflictCodes = (r: typeof pbDoctor): string[] =>
      [...new Set(r.findings.map((f) => f.code).filter((c) => c.startsWith('pack-conflict:')))].sort();
    expect(conflictCodes(pbDoctor)).toEqual(conflictCodes(hintDoctor));
    expect(conflictCodes(pbDoctor)).toContain('pack-conflict:invalid-contribution');
    expect(pbDoctor.verdict).toBe(hintDoctor.verdict);
    expect(pbDoctor.verdict).toBe('errors');
  }, TIMEOUT_MS);
});

// ── 8. area-explore classifies through the one classifier ───────────────────

describe('item 8 — area-explore uses THE area classifier, with an explicit directory rule', () => {
  test('a config pattern for libs/core/** gives only libs/core its kind', async () => {
    const root = workspace(
      {
        'libs/core/a.ts': 'export const A = 1;\n',
        'libs/core/b.ts': 'export const B = 1;\n',
        'libs/ui/c.ts': 'export const C = 1;\n',
        'libs/ui/d.ts': 'export const D = 1;\n',
      },
      "export default { projectName: 'fx', areaMap: { patterns: [{ kind: 'core', match: ['libs/core/**'] }] } };\n",
    );
    const inspection = await inspectSharkcraft({ cwd: root });
    // A file is classified directly; a directory by the majority of its files.
    expect(exploreArea({ inspection, path: 'libs/core/a.ts' }).inferredKind).toBe(AreaKind.Core);
    expect(exploreArea({ inspection, path: 'libs/core' }).inferredKind).toBe(AreaKind.Core);
    // The prefix match on the area map's `paths` (just `libs`) used to paint these core too.
    expect(exploreArea({ inspection, path: 'libs/ui/c.ts' }).inferredKind).not.toBe(AreaKind.Core);
    expect(exploreArea({ inspection, path: 'libs/ui' }).inferredKind).not.toBe(AreaKind.Core);
  }, TIMEOUT_MS);
});

// ── 13. one authority each ─────────────────────────────────────────────────

describe('item 13 — changes-summary and spec evidence read the boundaries lane authorities', () => {
  test('changes-summary: a `!` from-entry exempts a file from the rule\'s area (it is not a literal glob)', async () => {
    const root = workspace(
      {
        'sharkcraft/boundaries.ts':
          "export default [{ id: 'domain.layer', title: 'Domain', severity: 'error', tags: ['domain'], from: ['lib/domain/**', '!lib/domain/**/*.gen.ts'], forbiddenImports: ['@scope/ui'] }];\n",
        'lib/domain/a.ts': 'export const A = 1;\n',
        'lib/domain/b.gen.ts': 'export const B = 1;\n',
      },
      WITH_BOUNDARIES,
    );
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildChangesSummary(inspection, { files: ['lib/domain/a.ts', 'lib/domain/b.gen.ts'] });
    const areaOf = (p: string): string | undefined => report.files.find((f) => f.path === p)?.area;
    expect(areaOf('lib/domain/a.ts')).toBe('domain');
    expect(areaOf('lib/domain/b.gen.ts')).not.toBe('domain');
  }, TIMEOUT_MS);

  test('spec evidence: a test file is whatever TEST_FILE_GLOBS says (now __mocks__ too)', () => {
    const report = mapChecklistToEvidence({
      criteria: [{ id: 'c1', text: 'billing retries' }],
      changedFiles: ['src/__mocks__/billing.ts', 'src/billing.spec.ts', '__tests__/billing.ts'],
      fileContents: {},
    });
    const kinds = new Map(report.criteria[0]!.evidence.map((e) => [e.file, e.kind]));
    expect(kinds.get('src/__mocks__/billing.ts')).toBe('test');
    expect(kinds.get('src/billing.spec.ts')).toBe('test');
    expect(kinds.get('__tests__/billing.ts')).toBe('test');
  });
});
