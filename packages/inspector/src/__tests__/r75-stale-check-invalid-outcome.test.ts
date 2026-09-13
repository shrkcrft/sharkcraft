/**
 * Round 11 §3.2 — the staleness ENGINE and the doctor, over real registries.
 *
 *  - A symbol reference with no `symbol`, and a kind outside the vocabulary,
 *    are `invalid` (failure `malformed`) — not `unknown`, the bucket an
 *    unfetched url lives in — and a bogus kind no longer crashes the sweep.
 *  - `shrk doctor` names each shape problem at authoring time: the missing
 *    field, the unknown kind (listing the vocabulary), the absolute path.
 *  - Two same-id objects in ONE module: only the first registers, and the
 *    loader's warning reaches the doctor as a "Loader warning" (the duplicate
 *    detector for one module; `duplicate-id` covers ids across files).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildKnowledgeStaleReport, ReferenceCheckOutcome } from '../knowledge-stale.ts';
import { ReferenceFailure } from '../reference-failure.ts';
import { inspectSharkcraft, runDoctor, type ISharkcraftInspection } from '../sharkcraft-inspector.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function workspace(knowledge: string): string {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r75-invalid-'));
  roots.push(root);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'fx', version: '0.0.0' }),
    'src/a.ts': 'export const A = 1;\n',
    'sharkcraft/knowledge.ts': knowledge,
    'sharkcraft/sharkcraft.config.ts': "export default { projectName: 'fx', knowledgeFiles: ['knowledge.ts'] };\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

const entry = (id: string, title: string, refs: string): string =>
  `{ id: '${id}', title: '${title}', type: 'technical', priority: 'medium', scope: [], tags: [], appliesWhen: [], content: '${title}.', references: ${refs} }`;

const KNOWLEDGE =
  `export const refs = ${entry('k.refs', 'Refs', "[{ kind: 'symbol', path: 'src/a.ts' }, { kind: 'file', path: '/src/a.ts' }, { kind: 'file', path: 'src/a.ts' }, { kind: 'url', id: 'https://example.com' }]")};\n` +
  `export const bogus = ${entry('k.bogus', 'Bogus', "[{ kind: 'bogus-kind', path: 'x' }]")};\n` +
  `export const dupA = ${entry('dup.id', 'Dup from A', "[{ kind: 'file', path: 'src/a.ts' }]")};\n` +
  `export const dupB = ${entry('dup.id', 'Dup from B', "[{ kind: 'file', path: 'src/a.ts' }]")};\n`;

let insp: ISharkcraftInspection;
beforeAll(async () => {
  insp = await inspectSharkcraft({ cwd: workspace(KNOWLEDGE) });
});

describe('the engine — malformed is its own outcome', () => {
  test('a symbol with no `symbol` and a bogus kind are invalid/malformed; a url stays unknown; no throw', () => {
    const r = buildKnowledgeStaleReport(insp);
    // Module-namespace export order is not source order — group per entry.
    const byEntry = new Map<string, unknown[][]>();
    for (const c of r.referenceChecks) {
      const list = byEntry.get(c.entryId) ?? [];
      list.push([c.reference.kind, c.outcome, c.failure ?? null]);
      byEntry.set(c.entryId, list);
    }
    expect(byEntry.get('k.refs')).toEqual([
      ['symbol', ReferenceCheckOutcome.Invalid, ReferenceFailure.Malformed],
      // The leading slash still resolves (lenient); the validator warns about it.
      ['file', ReferenceCheckOutcome.Ok, null],
      ['file', ReferenceCheckOutcome.Ok, null],
      ['url', ReferenceCheckOutcome.Unknown, ReferenceFailure.Unverifiable],
    ]);
    expect(byEntry.get('k.bogus')).toEqual([['bogus-kind', ReferenceCheckOutcome.Invalid, ReferenceFailure.Malformed]]);
    expect(byEntry.get('dup.id')).toEqual([['file', ReferenceCheckOutcome.Ok, null]]);
    expect(r.counts).toEqual({ ok: 3, stale: 0, missing: 0, unknown: 1, invalid: 2 });
    expect(r.failureCounts[ReferenceFailure.Malformed]).toBe(2);
    expect(r.byReferenceKind['symbol']).toMatchObject({ checked: 1, invalid: 1, unknown: 0 });
    expect(r.referenceChecks.find((c) => c.entryId === 'k.bogus')?.message).toContain(
      'expected one of: file, directory, symbol',
    );
  });

  test('an entry whose only reference is malformed is unverifiable — never verified', () => {
    const r = buildKnowledgeStaleReport(insp);
    expect(r.unverifiableIds).toEqual(['k.bogus']);
  });
});

describe('the doctor — authoring-time names for each shape problem', () => {
  test('missing field, unknown kind and absolute path are Knowledge validation lines', () => {
    const doctor = runDoctor(insp);
    const lines = doctor.checks.filter((c) => c.title.startsWith('Knowledge validation'));
    const find = (code: string, needle: string): boolean =>
      lines.some((c) => c.title === `Knowledge validation (${code})` && c.message.includes(needle));
    expect(find('invalid-reference', 'reference #1 (symbol) has no `symbol`')).toBe(true);
    expect(find('invalid-reference', 'unknown kind "bogus-kind" — expected one of:')).toBe(true);
    expect(find('reference-absolute-path', 'path "/src/a.ts" is absolute')).toBe(true);
  });

  test('two same-id objects in one module: the first registers, the doctor carries the loader warning', () => {
    expect(insp.knowledgeEntries.filter((e) => e.id === 'dup.id').map((e) => e.title)).toEqual(['Dup from A']);
    const loader = runDoctor(insp).checks.filter((c) => c.title === 'Loader warning');
    expect(loader.some((c) => c.message.includes('duplicate id "dup.id"') && c.message.includes('export "dupB"'))).toBe(true);
  });
});
