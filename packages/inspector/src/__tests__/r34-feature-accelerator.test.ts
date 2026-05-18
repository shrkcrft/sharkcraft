/**
 * Closure tests covering deferred modules.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyFolderOps,
  checkFolderOpSafety,
  FolderOpSafety,
} from '@shrkcrft/generator';
import {
  buildUniversalSearch,
  uncertaintyReportFromSummary,
  buildPackContributionsInventory,
  buildSelfConfigDoctorReport,
  buildPackSignatureStatusReport,
  buildFeedbackActionsReport,
  buildFeedbackBacklogReport,
  buildFeedbackPlanReport,
  inspectSharkcraft,
} from '../index.ts';
import {
  validateConvention,
  ConventionKind,
  ConventionSeverity,
  validatePackHelper,
  PackHelperOutputKind,
  validateTaskRoutingHint,
} from '@shrkcrft/plugin-api';
import { buildUncertaintySummary } from '../uncertainty.ts';
import { buildTaskPacket } from '../task-packet.ts';

function makeTempRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `r34-${prefix}-`));
}

describe('folder op safety + apply', () => {
  test('checkFolderOpSafety rejects .git', () => {
    const root = makeTempRepo('safety');
    const r = checkFolderOpSafety(root, 'libs/foo/.git/objects', 'rename-folder');
    expect(r.safety).toBe(FolderOpSafety.Unsafe);
    rmSync(root, { recursive: true });
  });

  test('checkFolderOpSafety rejects paths outside project root', () => {
    const root = makeTempRepo('safety-outside');
    const r = checkFolderOpSafety(root, '../escape', 'rename-folder');
    expect(r.safety).toBe(FolderOpSafety.Unsafe);
    rmSync(root, { recursive: true });
  });

  test('checkFolderOpSafety rejects delete-folder without explicit flag', () => {
    const root = makeTempRepo('safety-delete');
    mkdirSync(join(root, 'libs/foo'), { recursive: true });
    const r = checkFolderOpSafety(root, 'libs/foo', 'delete-folder');
    expect(r.safety).toBe(FolderOpSafety.Unsafe);
    rmSync(root, { recursive: true });
  });

  test('checkFolderOpSafety accepts safe rename target', () => {
    const root = makeTempRepo('safety-rename');
    mkdirSync(join(root, 'libs/foo'), { recursive: true });
    const r = checkFolderOpSafety(root, 'libs/foo', 'rename-folder');
    expect(r.safety).toBe(FolderOpSafety.Safe);
    rmSync(root, { recursive: true });
  });

  test('applyFolderOps requires --allow-folder-ops', () => {
    const root = makeTempRepo('apply-noflag');
    mkdirSync(join(root, 'libs/foo'), { recursive: true });
    const r = applyFolderOps(
      [{ kind: 'rename-folder', targetPath: 'libs/foo', newPath: 'libs/bar' }],
      { projectRoot: root, dryRun: false },
    );
    expect(r.rejected.length).toBe(1);
    expect(r.applied.length).toBe(0);
    rmSync(root, { recursive: true });
  });

  test('applyFolderOps performs safe rename when allowed', () => {
    const root = makeTempRepo('apply-rename');
    mkdirSync(join(root, 'libs/foo'), { recursive: true });
    const r = applyFolderOps(
      [{ kind: 'rename-folder', targetPath: 'libs/foo', newPath: 'libs/bar' }],
      { projectRoot: root, dryRun: false, allowFolderOps: true },
    );
    expect(r.applied.length).toBe(1);
    expect(r.rejected.length).toBe(0);
    rmSync(root, { recursive: true });
  });

  test('applyFolderOps rejects delete-folder without --allow-delete-folder', () => {
    const root = makeTempRepo('apply-deny-del');
    mkdirSync(join(root, 'libs/foo'), { recursive: true });
    const r = applyFolderOps(
      [{ kind: 'delete-folder', targetPath: 'libs/foo' }],
      { projectRoot: root, dryRun: false, allowFolderOps: true },
    );
    expect(r.rejected.length).toBe(1);
    rmSync(root, { recursive: true });
  });

  test('applyFolderOps deletes when both flags are present', () => {
    const root = makeTempRepo('apply-del');
    mkdirSync(join(root, 'libs/foo'), { recursive: true });
    writeFileSync(join(root, 'libs/foo/x.ts'), '');
    const r = applyFolderOps(
      [{ kind: 'delete-folder', targetPath: 'libs/foo' }],
      {
        projectRoot: root,
        dryRun: false,
        allowFolderOps: true,
        allowDeleteFolder: true,
      },
    );
    expect(r.applied.length).toBe(1);
    rmSync(root, { recursive: true });
  });
});

describe('conventions / pack helpers / routing hints validation', () => {
  test('validateConvention rejects invalid shape', () => {
    const r = validateConvention({ id: 'x' });
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.field === 'title')).toBe(true);
  });

  test('validateConvention accepts a complete convention', () => {
    const r = validateConvention({
      id: 'example.naming',
      title: 'Example',
      kind: ConventionKind.Naming,
      rules: [{ id: 'r1', description: 'do x' }],
      severity: ConventionSeverity.Info,
    });
    expect(r.valid).toBe(true);
  });

  test('validatePackHelper requires safety.outputKind', () => {
    const r = validatePackHelper({
      id: 'h',
      title: 'h',
      variables: [],
      safety: { readOnly: true, outputKind: PackHelperOutputKind.Preview },
    });
    expect(r.valid).toBe(true);
  });

  test('validateTaskRoutingHint requires match + recommends', () => {
    const r = validateTaskRoutingHint({ id: 'x', title: 'x' });
    expect(r.valid).toBe(false);
  });
});

describe('uncertainty report + universal search', () => {
  test('uncertaintyReportFromSummary derives confidence and reasons', () => {
    const root = makeTempRepo('uncertainty');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(join(root, 'sharkcraft/sharkcraft.config.ts'), `export default {};`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r34' }));
    const inspectAsync = async () => {
      const insp = await inspectSharkcraft({ cwd: root });
      const packet = buildTaskPacket(insp, 'some task');
      const summary = buildUncertaintySummary(packet);
      const report = uncertaintyReportFromSummary(summary);
      expect(['high', 'medium', 'low'].includes(report.confidence)).toBe(true);
      expect(report.safeFallbackCommand.length).toBeGreaterThan(0);
    };
    return inspectAsync().finally(() => rmSync(root, { recursive: true }));
  });

  test('buildUniversalSearch returns 7-section report', async () => {
    const root = makeTempRepo('search');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(join(root, 'sharkcraft/sharkcraft.config.ts'), `export default {};`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r34' }));
    const inspection = await inspectSharkcraft({ cwd: root });
    const result = await buildUniversalSearch(inspection, 'rename plugin');
    expect(result.schema).toBe('sharkcraft.universal-search/v2');
    expect(result.sections.bestActions).toBeDefined();
    expect(result.sections.commands).toBeDefined();
    expect(result.sections.contributions).toBeDefined();
    expect(result.sections.knowledge).toBeDefined();
    expect(result.sections.validation).toBeDefined();
    expect(result.uncertainty).toBeDefined();
    expect(result.whyTheseRanked.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true });
  });
});

describe('pack contributions / self-config / pack signature', () => {
  test('buildPackContributionsInventory returns local entries on empty repo', async () => {
    const root = makeTempRepo('pack-inv');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(join(root, 'sharkcraft/sharkcraft.config.ts'), `export default {};`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r34' }));
    const inspection = await inspectSharkcraft({ cwd: root });
    const inv = buildPackContributionsInventory(inspection);
    expect(inv.schema).toBe('sharkcraft.pack-contributions-inventory/v1');
    expect(typeof inv.totals).toBe('object');
    rmSync(root, { recursive: true });
  });

  test('buildSelfConfigDoctorReport returns ok on empty repo', async () => {
    const root = makeTempRepo('sc-doc');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(join(root, 'sharkcraft/sharkcraft.config.ts'), `export default {};`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r34' }));
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = await buildSelfConfigDoctorReport(inspection);
    expect(['ok', 'warnings', 'errors'].includes(report.verdict)).toBe(true);
    rmSync(root, { recursive: true });
  });

  test('buildPackSignatureStatusReport never fake-signs', async () => {
    const root = makeTempRepo('pack-sig');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(join(root, 'sharkcraft/sharkcraft.config.ts'), `export default {};`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r34' }));
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildPackSignatureStatusReport(inspection);
    expect(report.schema).toBe('sharkcraft.pack-signature-status/v1');
    expect(report.summary.total).toBe(0);
    rmSync(root, { recursive: true });
  });
});

describe('feedback actions v2', () => {
  test('buildFeedbackActionsReport returns v2 schema', async () => {
    const root = makeTempRepo('feedback');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(join(root, 'sharkcraft/sharkcraft.config.ts'), `export default {};`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r34' }));
    writeFileSync(
      join(root, 'feedback.md'),
      '- Missing: the plugin renamer is too noisy.\n- The boundary check should be faster.\n',
    );
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildFeedbackActionsReport(inspection, 'feedback.md');
    expect(report.schema).toBe('sharkcraft.feedback-actions/v2');
    expect(report.actions.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true });
  });

  test('buildFeedbackBacklogReport groups by priority', async () => {
    const root = makeTempRepo('feedback-bl');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(join(root, 'sharkcraft/sharkcraft.config.ts'), `export default {};`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r34' }));
    writeFileSync(join(root, 'feedback.md'), '- Missing: x\n- Blocker: y\n');
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildFeedbackBacklogReport(inspection, 'feedback.md');
    expect(report.schema).toBe('sharkcraft.feedback-backlog/v1');
    expect(report.markdown.startsWith('# Feedback backlog')).toBe(true);
    rmSync(root, { recursive: true });
  });

  test('buildFeedbackPlanReport includes validation gates', async () => {
    const root = makeTempRepo('feedback-pl');
    mkdirSync(join(root, 'sharkcraft'), { recursive: true });
    writeFileSync(join(root, 'sharkcraft/sharkcraft.config.ts'), `export default {};`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r34' }));
    writeFileSync(join(root, 'feedback.md'), '- Bug: the apply command crashed.\n');
    const inspection = await inspectSharkcraft({ cwd: root });
    const report = buildFeedbackPlanReport(inspection, 'feedback.md');
    expect(report.schema).toBe('sharkcraft.feedback-plan/v1');
    expect(report.validationGates.length).toBeGreaterThan(0);
    rmSync(root, { recursive: true });
  });
});
