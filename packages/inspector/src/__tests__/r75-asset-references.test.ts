/**
 * Round 11, 4.3#3 — boundary rules and policy checks declare `references[]`
 * (the knowledge shape, from core) and the ONE staleness sweep checks them,
 * counted per asset kind. Boundary `from` globs whose static prefix does not
 * exist are implicit references (advisory; `--fail-on implicit` gates).
 *
 * Real boundaries.ts / policies.ts fixture through the real loaders.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateBoundaryRule } from '@shrkcrft/boundaries';
import type { IAssetReference } from '@shrkcrft/core';
import type { IKnowledgeReference } from '@shrkcrft/knowledge';
import { KnowledgeAdvisoryCode } from '../knowledge-advisory-code.ts';
import {
  buildKnowledgeStaleReport,
  ReferenceCheckOutcome,
  type IKnowledgeStaleReport,
} from '../knowledge-stale.ts';
import { ReferenceAssetKind } from '../reference-asset-kind.ts';
import { ReferenceFailure } from '../reference-failure.ts';
import { warmReferenceRegistries } from '../reference-registry.ts';
import { inspectSharkcraft } from '../sharkcraft-inspector.ts';

const root = mkdtempSync(join(tmpdir(), 'shrk-r75-assets-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let report: IKnowledgeStaleReport;
beforeAll(async () => {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'afx', version: '0.0.0' }),
    'src/a.ts': 'export const A = 1;\n',
    'sharkcraft/boundaries.ts':
      'export default [\n' +
      "  { id: 'dead-from-rule', title: 'Dead', from: ['apps/legacy/**', 'src/**'], forbiddenImports: ['lodash'], references: [{ kind: 'directory', path: 'apps/legacy' }] },\n" +
      "  { id: 'live-rule', title: 'Live', from: ['src/**'], forbiddenImports: ['lodash'], references: [{ kind: 'file', path: 'src/a.ts' }] },\n" +
      '];\n',
    'sharkcraft/policies.ts':
      'export default [\n' +
      "  { id: 'pol.with-refs', title: 'With refs', evaluate: () => true, references: [{ kind: 'directory', path: 'src' }] },\n" +
      "  { id: 'pol.no-refs', title: 'No refs', evaluate: () => true },\n" +
      '];\n',
    'sharkcraft/knowledge.ts':
      "export default [{ id: 'k.one', title: 'One', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: 'x', references: [{ kind: 'file', path: 'src/a.ts' }] }];\n",
    'sharkcraft/sharkcraft.config.ts':
      "export default { projectName: 'afx', knowledgeFiles: ['knowledge.ts'], boundaryFiles: ['boundaries.ts'] };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const insp = await inspectSharkcraft({ cwd: root });
  await warmReferenceRegistries(insp);
  report = buildKnowledgeStaleReport(insp);
});

describe('declared references on boundary rules', () => {
  test('a stale declared directory is swept, tagged with its asset kind', () => {
    const declared = report.assetReferenceChecks.find(
      (c) => c.entryId === 'dead-from-rule' && c.implicit !== true,
    );
    expect(declared).toMatchObject({
      assetKind: ReferenceAssetKind.BoundaryRule,
      outcome: ReferenceCheckOutcome.Stale,
      failure: ReferenceFailure.PathMissing,
    });
    const live = report.assetReferenceChecks.find((c) => c.entryId === 'live-rule');
    expect(live?.outcome).toBe(ReferenceCheckOutcome.Ok);
    expect(report.byAssetKind[ReferenceAssetKind.BoundaryRule]).toMatchObject({
      scanned: 2,
      zeroReferences: 0,
      verified: 1,
      stale: 1,
    });
  });

  test('a dead `from` prefix is an IMPLICIT path-missing reference, and an advisory', () => {
    const implicit = report.assetReferenceChecks.filter((c) => c.implicit === true);
    expect(implicit.map((c) => [c.entryId, c.reference.path])).toEqual([['dead-from-rule', 'apps/legacy']]);
    expect(
      report.advisories.some(
        (a) => a.code === KnowledgeAdvisoryCode.ImplicitPathMissing && a.subjectId === 'dead-from-rule',
      ),
    ).toBe(true);
    // Implicit references are advisory: never counted as a failure mode.
    expect(report.failureCounts[ReferenceFailure.PathMissing]).toBe(1);
  });

  test('other assets never leak into the knowledge buckets', () => {
    expect(report.coverage).toMatchObject({ entriesInScope: 1, verified: 1, unverifiable: 0 });
    expect(report.referenceChecks.every((c) => c.assetKind === undefined)).toBe(true);
  });
});

describe('policy checks', () => {
  test('declared references are swept after warming; an unreferenced check is counted, not hidden', () => {
    expect(report.policySweep).toEqual({ loaded: true, declared: 2, withReferences: 1 });
    expect(report.byAssetKind[ReferenceAssetKind.Policy]).toMatchObject({
      scanned: 2,
      zeroReferences: 1,
      verified: 1,
      unverifiable: 1,
    });
    const pol = report.assetReferenceChecks.find((c) => c.entryId === 'local:pol.with-refs');
    expect(pol?.outcome).toBe(ReferenceCheckOutcome.Ok);
    expect(report.advisories.some((a) => a.code === KnowledgeAdvisoryCode.PolicyScopeUnverifiable)).toBe(true);
  });
});

describe('the shared shape', () => {
  test('validateBoundaryRule rejects a malformed reference kind', () => {
    const v = validateBoundaryRule({
      id: 'r',
      title: 'R',
      from: ['src/**'],
      forbiddenImports: ['x'],
      references: [{ kind: 'bogus', path: 'src' }],
    });
    expect(v.valid).toBe(false);
    expect(v.issues.map((i) => i.field)).toContain('references[0].kind');
  });

  test('IKnowledgeReference is core\'s IAssetReference (type-level)', () => {
    const asset: IAssetReference = { kind: 'file', path: 'src/a.ts', contains: 'A' };
    const knowledge: IKnowledgeReference = asset;
    const back: IAssetReference = knowledge;
    expect(back).toBe(asset);
  });
});
