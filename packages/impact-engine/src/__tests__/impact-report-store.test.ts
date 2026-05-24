import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRAPH_IMPACT_SCHEMA,
  type IGraphImpactAnalysis,
} from '../schema/impact-analysis.ts';
import {
  IMPACT_RUN_SCHEMA,
  ImpactReportStore,
  snapshotImpactAnalysis,
} from '../runner/impact-report-store.ts';

function fixtureAnalysis(): IGraphImpactAnalysis {
  return {
    schema: GRAPH_IMPACT_SCHEMA,
    inputKind: 'files',
    normalizedTargets: ['packages/foo/src/index.ts'],
    directDependents: [
      { id: 'file:packages/bar/src/use.ts', label: 'use.ts', kind: 'file', path: 'packages/bar/src/use.ts' },
    ],
    transitiveDependents: [],
    affectedSymbols: [],
    affectedCallerFiles: [],
    affectedPackages: ['@x/foo', '@x/bar'],
    affectedRules: [],
    affectedPaths: [],
    affectedTemplates: [],
    likelyTests: [
      { id: 'file:packages/foo/src/__tests__/x.test.ts', label: 'x.test.ts', kind: 'file', path: 'packages/foo/src/__tests__/x.test.ts' },
    ],
    publicApiTouched: true,
    risk: 'high',
    riskReasons: ['public API'],
    validationScope: ['bun test packages/foo'],
    truncations: {},
    diagnostics: [],
  };
}

describe('ImpactReportStore + snapshotImpactAnalysis', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'shrk-impact-store-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('snapshot rolls up counts and carries over risk/validation', () => {
    const snap = snapshotImpactAnalysis(fixtureAnalysis(), 'packages/foo/src/index.ts');
    expect(snap.schema).toBe(IMPACT_RUN_SCHEMA);
    expect(snap.directDependentCount).toBe(1);
    expect(snap.affectedPackageCount).toBe(2);
    expect(snap.likelyTestCount).toBe(1);
    expect(snap.publicApiTouched).toBe(true);
    expect(snap.risk).toBe('high');
    expect(snap.validationScope).toEqual(['bun test packages/foo']);
    expect(snap.inputSummary).toBe('packages/foo/src/index.ts');
  });

  test('write+read round-trips, exists() honours absence', () => {
    const store = new ImpactReportStore(root);
    expect(store.exists()).toBe(false);
    expect(store.read()).toBeUndefined();
    const snap = snapshotImpactAnalysis(fixtureAnalysis(), 'x');
    store.write(snap);
    expect(store.exists()).toBe(true);
    expect(existsSync(store.absPath)).toBe(true);
    const round = store.read();
    expect(round?.schema).toBe(IMPACT_RUN_SCHEMA);
    expect(round?.inputSummary).toBe('x');
  });

  test('read returns undefined when schema field is unknown', () => {
    const store = new ImpactReportStore(root);
    const snap = snapshotImpactAnalysis(fixtureAnalysis(), 'x');
    store.write({ ...snap, schema: 'sharkcraft.impact-run/v99' as never });
    expect(store.read()).toBeUndefined();
  });

  test('writeBaseline + readBaseline round-trips independently of last', () => {
    const store = new ImpactReportStore(root);
    const snap = snapshotImpactAnalysis(fixtureAnalysis(), 'baseline-x');
    store.writeBaseline(snap);
    expect(store.baselineExists()).toBe(true);
    const round = store.readBaseline();
    expect(round?.inputSummary).toBe('baseline-x');
  });

  test('clearBaseline is idempotent', () => {
    const store = new ImpactReportStore(root);
    const snap = snapshotImpactAnalysis(fixtureAnalysis(), 'x');
    store.writeBaseline(snap);
    expect(store.clearBaseline()).toBe(true);
    expect(store.clearBaseline()).toBe(false);
    expect(store.baselineExists()).toBe(false);
  });
});

import { diffImpactReports } from '../runner/impact-report-store.ts';

describe('diffImpactReports', () => {
  test('identical reports produce zero delta and not-worsened', () => {
    const r = snapshotImpactAnalysis(fixtureAnalysis(), 'x');
    const delta = diffImpactReports(r, r);
    expect(delta.dependentDelta).toBe(0);
    expect(delta.packageDelta).toBe(0);
    expect(delta.worsened).toBe(false);
  });

  test('worsened risk flips the worsened flag and labels the drift', () => {
    const base = snapshotImpactAnalysis(
      { ...fixtureAnalysis(), risk: 'low', riskReasons: [] },
      'x',
    );
    const next = snapshotImpactAnalysis(
      { ...fixtureAnalysis(), risk: 'high', riskReasons: ['public API'] },
      'x',
    );
    const delta = diffImpactReports(base, next);
    expect(delta.worsened).toBe(true);
    expect(delta.riskDrift).toBe('low → high');
  });

  test('growing dependent counts mark worsened even when risk stayed the same', () => {
    const base = snapshotImpactAnalysis(fixtureAnalysis(), 'x');
    const inflated = {
      ...fixtureAnalysis(),
      directDependents: [
        ...fixtureAnalysis().directDependents,
        { id: 'file:packages/extra/use.ts', label: 'use', kind: 'file', path: 'p/extra.ts' },
        { id: 'file:packages/extra2/use.ts', label: 'use', kind: 'file', path: 'p/extra2.ts' },
      ],
    };
    const next = snapshotImpactAnalysis(inflated, 'x');
    const delta = diffImpactReports(base, next);
    expect(delta.dependentDelta).toBe(2);
    expect(delta.worsened).toBe(true);
  });
});
