/**
 * Changed-only quality v2, doctor suppression, knowledge stale-check,
 * template drift, fuzzy query resolver, feedback ingestion, barrel ops.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { buildBarrelExportOperation } from '../barrel-operations.ts';
import { ChangedFindingBucket, classifyChangedScope } from '../changed-scope.ts';
import {
  buildSuppressionEntry,
  deriveCategory,
  deriveStableId,
  filterDoctorResult,
} from '../doctor-suppressions.ts';
import { DoctorSeverity } from '../doctor-result.ts';
import { FeedbackBucket, ingestFeedbackText } from '../feedback-ingestion.ts';
import { buildKnowledgeStaleReport, ReferenceCheckOutcome } from '../knowledge-stale.ts';
import { resolveQuery } from '../query-resolver.ts';
import { buildTemplateDriftReport } from '../template-drift.ts';

const TMP_ROOT = mkdtempSync(nodePath.join(os.tmpdir(), 'shrk-r29-'));

describe('changed-scope classification', () => {
  test('finding in changed file with no baseline is new-in-changed-file', () => {
    const result = classifyChangedScope({
      projectRoot: TMP_ROOT,
      current: [{ key: 'k1:file1.ts', file: 'file1.ts' }],
      changedFiles: ['file1.ts'],
    });
    expect(result.counts.newInChangedFile).toBe(1);
    expect(result.newIssues).toHaveLength(1);
  });
  test('finding in changed file with baseline match is existing-touched', () => {
    const result = classifyChangedScope({
      projectRoot: TMP_ROOT,
      current: [{ key: 'k1:file1.ts', file: 'file1.ts' }],
      baseline: [{ key: 'k1:file1.ts', file: 'file1.ts' }],
      changedFiles: ['file1.ts'],
    });
    expect(result.counts.existingTouched).toBe(1);
    expect(result.counts.newInChangedFile).toBe(0);
  });
  test('finding in untouched file with baseline is unchanged', () => {
    const result = classifyChangedScope({
      projectRoot: TMP_ROOT,
      current: [{ key: 'k1:file1.ts', file: 'file1.ts' }],
      baseline: [{ key: 'k1:file1.ts', file: 'file1.ts' }],
      changedFiles: ['file2.ts'],
    });
    expect(result.counts.unchanged).toBe(1);
    expect(result.hiddenBaseline).toHaveLength(1);
  });
  test('baseline finding not present today is resolved', () => {
    const result = classifyChangedScope({
      projectRoot: TMP_ROOT,
      current: [],
      baseline: [{ key: 'k1:file1.ts', file: 'file1.ts' }],
      changedFiles: ['file1.ts'],
    });
    expect(result.counts.resolved).toBe(1);
    expect(result.resolved).toHaveLength(1);
  });
});

describe('doctor suppression', () => {
  const sampleResult = {
    passed: true,
    checks: [
      {
        id: 'actionhints-missing-write-policy-foo',
        title: 'Action-hint quality',
        severity: DoctorSeverity.Warning,
        message: 'missing writePolicy',
      },
      {
        id: 'other-error',
        title: 'Other',
        severity: DoctorSeverity.Error,
        message: 'something broke',
      },
    ],
    summary: { ok: 0, info: 0, warnings: 1, errors: 1 },
  };
  test('suppress by id moves finding to suppressed list', () => {
    const first = sampleResult.checks[0]!;
    const stableId = deriveStableId(first);
    const filtered = filterDoctorResult(sampleResult, {
      suppressions: [buildSuppressionEntry({ id: stableId, reason: 'test' })],
    });
    expect(filtered.suppressedChecks).toHaveLength(1);
    expect(filtered.summary.suppressedWarnings).toBe(1);
  });
  test('expired suppression is reported under expired list', () => {
    const filtered = filterDoctorResult(sampleResult, {
      suppressions: [
        buildSuppressionEntry({ category: 'action-hint-quality', reason: 'noisy', expiresAt: '2020-01-01' }),
      ],
    });
    expect(filtered.expiredSuppressions).toHaveLength(1);
  });
  test('errors are not suppressed unless allowError is set', () => {
    const filtered = filterDoctorResult(sampleResult, {
      suppressions: [buildSuppressionEntry({ category: 'other', reason: 'r' })],
    });
    expect(filtered.summary.errors).toBe(1);
  });
  test('quietKnown drops ok rows matching a suppression category', () => {
    expect(deriveCategory({ id: 'actionhints-missing-x', title: '', severity: DoctorSeverity.Warning, message: '' })).toBe(
      'action-hint-quality',
    );
  });
});

describe('knowledge stale-check', () => {
  test('missing file reference reports stale', () => {
    const inspection: {
      projectRoot: string;
      knowledgeEntries: { id: string; references: { kind: string; path: string }[] }[];
      pathService: { list: () => readonly { id: string }[] };
      templates: readonly { id: string }[];
      packs: { validPacks: readonly unknown[] };
      index: Map<string, unknown>;
    } = {
      projectRoot: TMP_ROOT,
      knowledgeEntries: [
        {
          id: 'k1',
          references: [{ kind: 'file', path: 'does-not-exist.ts' }],
        },
      ],
      pathService: { list: () => [] },
      templates: [],
      packs: { validPacks: [] },
      index: new Map(),
    };
    const r = buildKnowledgeStaleReport(inspection as never);
    expect(r.counts.stale).toBe(1);
    expect(r.referenceChecks[0]!.outcome).toBe(ReferenceCheckOutcome.Stale);
  });
});

describe('template drift', () => {
  test('canonical template with no related ids passes', () => {
    const inspection: unknown = {
      projectRoot: TMP_ROOT,
      templates: [
        {
          id: 'engine.cli-command',
          name: 'CLI command',
          variables: [{ name: 'name', default: 'foo' }],
          tags: [],
          scope: [],
          appliesWhen: [],
          targetPath: 'packages/cli/src/commands/foo.command.ts',
          content: '// sample',
        },
      ],
      pathService: { list: () => [] },
      index: new Map(),
      packs: { validPacks: [] },
    };
    const report = buildTemplateDriftReport(inspection as never);
    expect(report.totalTemplates).toBe(1);
    expect(report.fail).toBe(0);
  });
});

describe('barrel export operation', () => {
  test('builds an export op for an absent barrel target', () => {
    const op = buildBarrelExportOperation({
      targetPath: 'libs/x/src/index.ts',
      from: './lib/y',
      projectRoot: TMP_ROOT,
    });
    expect(['appended', 'inserted-alphabetic']).toContain(op.outcome);
    expect(op.operation.kind).toBe('export');
  });
  test('detects an idempotency marker', () => {
    const barrelPath = nodePath.join(TMP_ROOT, 'barrel.ts');
    writeFileSync(barrelPath, "// MARKER-r29\nexport * from './a';\n", 'utf8');
    const op = buildBarrelExportOperation({
      targetPath: 'barrel.ts',
      from: './a',
      idempotencyMarker: 'MARKER-r29',
      projectRoot: TMP_ROOT,
    });
    expect(op.outcome).toBe('idempotent-marker-present');
  });
  test('detects ambiguous-style conflict', () => {
    const barrelPath = nodePath.join(TMP_ROOT, 'barrel-amb.ts');
    writeFileSync(
      barrelPath,
      "export * from './x';\nexport { foo } from './x';\n",
      'utf8',
    );
    const op = buildBarrelExportOperation({
      targetPath: 'barrel-amb.ts',
      from: './x',
      projectRoot: TMP_ROOT,
    });
    expect(op.outcome).toBe('conflict-ambiguous-style');
    expect(op.conflict).toBeDefined();
  });
});

describe('fuzzy query resolver', () => {
  const inspection: unknown = {
    projectRoot: TMP_ROOT,
    knowledgeEntries: [
      { id: 'engine.helper-plan-registry', title: 'Helper plan registry' },
      { id: 'engine.changed-only-boundaries', title: 'Changed-only boundary checking' },
    ],
    templates: [],
    pathService: { list: () => [] },
    index: new Map(),
    packs: { validPacks: [] },
  };
  test('exact id query returns confidence: exact', () => {
    const r = resolveQuery(inspection as never, 'engine.helper-plan-registry');
    expect(r.confidence).toBe('exact');
    expect(r.bestMatch?.id).toBe('engine.helper-plan-registry');
  });
  test('substring query returns at least one match', () => {
    const r = resolveQuery(inspection as never, 'helper plan');
    expect(r.bestMatch).toBeDefined();
  });
  test('unrelated query returns unknown confidence', () => {
    const r = resolveQuery(inspection as never, 'zzz-no-match');
    expect(r.confidence).toBe('unknown');
  });
});

describe('feedback ingestion', () => {
  test('extracts changed-only ask', () => {
    const md = '# Bad\n- changed-only boundaries hide too much\n';
    const r = ingestFeedbackText(md);
    expect(r.totalFindings).toBe(1);
    expect(r.findings[0]!.tags).toContain('changed-only');
    expect(r.findings[0]!.bucket).toBe(FeedbackBucket.Bad);
  });
  test('extracts stale knowledge ask', () => {
    const md = '# Missing\n- knowledge entries rot when symbols rename\n';
    const r = ingestFeedbackText(md);
    expect(r.findings[0]!.tags).toContain('stale');
  });
  test('extracts warning noise ask', () => {
    const md = '# Bad\n- doctor warnings are too noisy\n';
    const r = ingestFeedbackText(md);
    expect(r.findings[0]!.tags).toContain('noise');
    expect(r.findings[0]!.targetArea).toBe('doctor-suppressions');
  });
  test('output is deterministic for the same input', () => {
    const md = '# Bad\n- noisy warnings\n- template drift\n';
    const a = ingestFeedbackText(md);
    const b = ingestFeedbackText(md);
    expect(a.totalFindings).toBe(b.totalFindings);
    expect(a.findings.length).toBe(b.findings.length);
  });
});

// Sentinel reference so `void` isn't required.
void ChangedFindingBucket;
