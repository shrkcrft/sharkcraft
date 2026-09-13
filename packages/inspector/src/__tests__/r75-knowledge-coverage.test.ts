/**
 * Round 11, 1.1 + 4.3#4 — the staleness engine classifies EVERY entry in scope
 * into verified / stale / unverifiable, and counts per kind in the same loop.
 *
 * Real temp project, loaded through the real config loader and inspector — no
 * hand-built inspection.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildKnowledgeStaleReport } from '../knowledge-stale.ts';
import { KnowledgeEntryVerdict } from '../knowledge-entry-verdict.ts';
import { KnowledgeUnverifiableReason } from '../knowledge-unverifiable-reason.ts';
import { ReferenceFailure } from '../reference-failure.ts';
import { warmReferenceRegistries } from '../reference-registry.ts';
import { inspectSharkcraft, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function entry(id: string, type: string, refs?: string): string {
  return (
    `{ id: '${id}', title: '${id}', type: '${type}', priority: 'medium', scope: [], tags: [], ` +
    `appliesWhen: [], content: 'About ${id}.'${refs ? `, references: ${refs}` : ''} }`
  );
}

async function project(entries: readonly string[]): Promise<ISharkcraftInspection> {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-kcov-engine-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'kfx', version: '0.0.0' }),
    'src/a.ts': 'export const A = 1;\n',
    'sharkcraft/knowledge.ts': `export default [\n  ${entries.join(',\n  ')}\n];\n`,
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'kfx', knowledgeFiles: ['knowledge.ts'] };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const inspection = await inspectSharkcraft({ cwd: root });
  await warmReferenceRegistries(inspection);
  return inspection;
}

describe('an unreferenced corpus is 100% unverifiable — never healthy', () => {
  test('N entries with 0 references', async () => {
    const insp = await project(['a', 'b', 'c', 'd'].map((id) => entry(`z.${id}`, 'rule')));
    const r = buildKnowledgeStaleReport(insp);
    expect(r.coverage).toEqual({
      entriesInScope: 4,
      verified: 0,
      stale: 0,
      unverifiable: 4,
      unverifiablePct: 100,
      referencedRatio: 0,
    });
    expect(r.unverifiableIds).toEqual(['z.a', 'z.b', 'z.c', 'z.d']);
    for (const v of r.entryVerdicts) expect(v.reason).toBe(KnowledgeUnverifiableReason.NoReferences);
  });
});

describe('a mixed corpus: exact buckets, per-kind counts, scope', () => {
  let insp: ISharkcraftInspection;
  beforeAll(async () => {
    insp = await project([
      entry('m.rule-ok', 'rule', "[{ kind: 'file', path: 'src/a.ts' }]"),
      entry('m.rule-none', 'rule'),
      entry('m.path-ok', 'path', "[{ kind: 'directory', path: 'src' }]"),
      entry('m.url-only', 'technical', "[{ kind: 'url', id: 'https://example.com/x' }]"),
      entry('m.stale', 'technical', "[{ kind: 'file', path: 'src/gone.ts' }]"),
      entry('m.ok-sym', 'technical', "[{ kind: 'file', path: 'src/a.ts' }, { kind: 'symbol', symbol: 'A', path: 'src/a.ts' }]"),
    ]);
  });

  test('three buckets that always add up to the scope', () => {
    const r = buildKnowledgeStaleReport(insp);
    expect(r.coverage).toMatchObject({ entriesInScope: 6, verified: 3, stale: 1, unverifiable: 2, unverifiablePct: 33.3 });
    expect(r.coverage.referencedRatio).toBeCloseTo(4 / 6, 5);
    const c = r.coverage;
    expect(c.verified + c.stale + c.unverifiable).toBe(c.entriesInScope);
  });

  test('a url-only entry is unverifiable for a different reason than a bare one', () => {
    const r = buildKnowledgeStaleReport(insp);
    const byId = new Map(r.entryVerdicts.map((v) => [v.entryId, v]));
    expect(byId.get('m.url-only')).toMatchObject({
      verdict: KnowledgeEntryVerdict.Unverifiable,
      reason: KnowledgeUnverifiableReason.OnlyUnverifiableReferences,
      checkable: 0,
    });
    expect(byId.get('m.rule-none')?.reason).toBe(KnowledgeUnverifiableReason.NoReferences);
    expect(byId.get('m.stale')).toMatchObject({ verdict: KnowledgeEntryVerdict.Stale, checkable: 1, failing: 1 });
    // The source names the file to edit, relative to the project root.
    expect(byId.get('m.rule-none')?.source).toBe('sharkcraft/knowledge.ts');
  });

  test('a stale entry counts toward the examined share (it WAS checked)', () => {
    const r = buildKnowledgeStaleReport(insp);
    expect(r.unverifiableIds).toEqual(['m.rule-none', 'm.url-only']);
    expect(r.failureCounts[ReferenceFailure.PathMissing]).toBe(1);
  });

  test('per entry type and per reference kind, from the same loop', () => {
    const r = buildKnowledgeStaleReport(insp);
    expect(r.byEntryType['rule']).toEqual({ scanned: 2, zeroReferences: 1, referencesChecked: 1, verified: 1, stale: 0, unverifiable: 1 });
    expect(r.byEntryType['path']).toMatchObject({ scanned: 1, verified: 1 });
    expect(r.byEntryType['technical']).toMatchObject({ scanned: 3, verified: 1, stale: 1, unverifiable: 1 });
    expect(r.byReferenceKind['file']).toEqual({ checked: 3, ok: 2, stale: 1, missing: 0, unknown: 0, invalid: 0 });
    expect(r.byReferenceKind['url']).toEqual({ checked: 1, ok: 0, stale: 0, missing: 0, unknown: 1, invalid: 0 });
    expect(r.byReferenceKind['symbol']).toMatchObject({ checked: 1, ok: 1 });
    expect(r.byAssetKind.knowledge).toMatchObject({ scanned: 6, zeroReferences: 1, verified: 3, stale: 1, unverifiable: 2 });
  });

  test('changedFiles narrows entriesInScope — never the corpus count', () => {
    const r = buildKnowledgeStaleReport(insp, { changedFiles: ['src/gone.ts'] });
    expect(r.entries).toBe(6);
    // `m.stale` pins the path; `m.path-ok` pins the DIRECTORY above it — a
    // change under a directory reference is in scope (a deleted directory
    // lists only its files).
    expect(r.entriesInScope).toBe(2);
    expect(r.entryVerdicts.map((v) => v.entryId)).toEqual(['m.path-ok', 'm.stale']);
    const none = buildKnowledgeStaleReport(insp, { changedFiles: ['README.md'] });
    expect(none.entriesInScope).toBe(0);
    expect(none.coverage.referencedRatio).toBe(0);
    // The file that DECLARES the entries changed: every entry in it is in scope.
    const declaring = buildKnowledgeStaleReport(insp, { changedFiles: ['sharkcraft/knowledge.ts'] });
    expect(declaring.entriesInScope).toBe(6);
  });
});
