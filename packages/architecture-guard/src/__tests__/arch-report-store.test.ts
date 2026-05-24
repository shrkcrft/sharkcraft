import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCH_REPORT_SCHEMA,
  type IArchReport,
} from '../schema/violation.ts';
import {
  ArchReportStore,
  ARCH_SNAPSHOT_SCHEMA,
  diffSnapshots,
  snapshotFromReport,
  violationId,
} from '../store/arch-report-store.ts';

function fixtureReport(): IArchReport {
  return {
    schema: ARCH_REPORT_SCHEMA,
    filesAnalyzed: 10,
    violations: [
      {
        kind: 'barrel-fat',
        severity: 'warning',
        message: 'fat barrel',
        file: 'src/foo.ts',
      },
      {
        kind: 'cycle',
        severity: 'error',
        message: 'cycle: a → b → a',
        file: 'src/a.ts',
        targetFile: 'src/b.ts',
        line: 3,
      },
    ],
    countsBySeverity: { error: 1, warning: 1, info: 0 },
    countsByKind: {
      'public-api-misuse': 0,
      'barrel-cycle': 0,
      'barrel-fat': 1,
      cycle: 1,
      'contract-import': 0,
      'contract-layer-skip': 0,
    },
    diagnostics: [],
  };
}

describe('ArchReportStore', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shrk-arch-store-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('write+read last round-trips and contains a sorted, stable violation-id list', () => {
    const store = new ArchReportStore(root);
    const snap = store.writeLast(fixtureReport());
    expect(snap.schema).toBe(ARCH_SNAPSHOT_SCHEMA);
    expect(snap.violationIds).toEqual([
      'barrel-fat|src/foo.ts',
      'cycle|src/a.ts:3|src/b.ts',
    ]);
    expect(existsSync(store.lastPath)).toBe(true);

    const round = store.readLast();
    expect(round).toBeDefined();
    expect(round!.violationIds).toEqual(snap.violationIds);
  });

  test('snapshot drops duplicate violations and stays stable across runs', () => {
    const report = fixtureReport();
    const dup: IArchReport = {
      ...report,
      violations: [...report.violations, report.violations[0]!],
    };
    const snap = snapshotFromReport(dup);
    // Set semantics on violationId — duplicates collapse.
    expect(snap.violationIds.length).toBe(2);
  });

  test('clearBaseline removes the file if present', () => {
    const store = new ArchReportStore(root);
    store.writeBaseline(fixtureReport());
    expect(existsSync(store.baselinePath)).toBe(true);
    expect(store.clearBaseline()).toBe(true);
    expect(existsSync(store.baselinePath)).toBe(false);
    // idempotent
    expect(store.clearBaseline()).toBe(false);
  });

  test('diffSnapshots: identical snapshots produce empty delta', () => {
    const snap = snapshotFromReport(fixtureReport());
    const delta = diffSnapshots(snap, snap);
    expect(delta.newViolationIds).toEqual([]);
    expect(delta.fixedViolationIds).toEqual([]);
    expect(delta.errorDelta).toBe(0);
    expect(delta.warningDelta).toBe(0);
  });

  test('diffSnapshots: new and fixed violations classified correctly', () => {
    const base = snapshotFromReport(fixtureReport());
    const next: IArchReport = {
      ...fixtureReport(),
      violations: [
        // keep barrel-fat|src/foo.ts (carry-over)
        {
          kind: 'barrel-fat',
          severity: 'warning',
          message: 'fat barrel',
          file: 'src/foo.ts',
        },
        // new violation
        {
          kind: 'public-api-misuse',
          severity: 'error',
          message: 'imports internal',
          file: 'src/c.ts',
          targetFile: 'packages/x/internal/h.ts',
        },
      ],
      countsBySeverity: { error: 1, warning: 1, info: 0 },
    };
    const after = snapshotFromReport(next);
    const delta = diffSnapshots(base, after);
    expect(delta.newViolationIds).toEqual([
      'public-api-misuse|src/c.ts|packages/x/internal/h.ts',
    ]);
    // cycle|... existed in base, missing in next ⇒ fixed
    expect(delta.fixedViolationIds).toEqual([
      'cycle|src/a.ts:3|src/b.ts',
    ]);
    expect(delta.errorDelta).toBe(0);
    expect(delta.warningDelta).toBe(0);
  });

  test('readBaseline rejects payloads with the wrong schema field', () => {
    const store = new ArchReportStore(root);
    store.writeBaseline(fixtureReport());
    // Tamper with schema by writing a different snapshot version.
    writeFileSync(
      store.baselinePath,
      JSON.stringify({
        schema: 'sharkcraft.architecture-snapshot/v2',
        generatedAt: new Date().toISOString(),
        filesAnalyzed: 0,
        countsBySeverity: { error: 0, warning: 0, info: 0 },
        countsByKind: {},
        violationIds: [],
      }),
      'utf8',
    );
    expect(store.readBaseline()).toBeUndefined();
  });

  test('violationId composes kind|file:line|target into a stable string', () => {
    expect(
      violationId({
        kind: 'cycle',
        severity: 'error',
        message: 'm',
        file: 'a.ts',
        line: 7,
        targetFile: 'b.ts',
      }),
    ).toBe('cycle|a.ts:7|b.ts');
    expect(
      violationId({
        kind: 'barrel-fat',
        severity: 'warning',
        message: 'm',
        file: 'a.ts',
      }),
    ).toBe('barrel-fat|a.ts');
  });
});
