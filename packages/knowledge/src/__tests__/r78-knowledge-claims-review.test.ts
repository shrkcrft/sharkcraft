/**
 * r78 — round 15 review of 15.2: every knowledge CLAIM field (`references`,
 * `anchors`) takes ONE path on bad input, whatever built the entry.
 *
 *   - `defineKnowledgeEntry` spread a non-list `references`: an object threw at
 *     import (`{ … }` is not iterable — the WHOLE file failed to load), a
 *     string split into characters. It is now carried as declared, so the
 *     validator keeps the entry and reports it (DECISIONS 15.2: "a non-list
 *     `references` value, in TS or in Markdown, becomes a validation issue that
 *     keeps the entry").
 *   - `anchors` get the same treatment: a non-list value, a `null` item or a
 *     non-string `path` is `invalid-anchor` (entry kept) — each crashed the
 *     stale-check, `knowledge anchors` or `ide symbol`.
 *   - `knowledgeReferenceListing` (what `knowledge references` and MCP
 *     `get_knowledge_references` print) names every item it cannot list, with
 *     the validator's words at the validator's position.
 *
 * Real loaders over real files.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KnowledgeClaimField,
  MarkdownKnowledgeLoader,
  TypeScriptKnowledgeLoader,
  knowledgeAnchors,
  knowledgeReferenceListing,
  knowledgeReferences,
  malformedKnowledgeClaimLabel,
  validateKnowledgeEntries,
} from '../index.ts';

/** The package entry a fixture imports `defineKnowledgeEntry` from — the real helper, not a copy. */
const KNOWLEDGE_INDEX = join(import.meta.dir, '..', 'index.ts');

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function write(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-claims-'));
  roots.push(dir);
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe('r78 defineKnowledgeEntry carries a non-list references value as declared', () => {
  test('an object and a string: the file loads, both entries are kept, the validator reports each', async () => {
    const r = await new TypeScriptKnowledgeLoader().load(
      write(
        'knowledge.ts',
        `import { defineKnowledgeEntry } from ${JSON.stringify(KNOWLEDGE_INDEX)};\n` +
          'export default [\n' +
          "  defineKnowledgeEntry({ id: 'k.obj', title: 'Obj', type: 'technical', content: 'x', references: { kind: 'file', path: 'src/a.ts' } as never }),\n" +
          "  defineKnowledgeEntry({ id: 'k.str', title: 'Str', type: 'technical', content: 'x', references: 'src/a.ts' as never }),\n" +
          '];\n',
      ),
    );
    expect(r.warnings.filter((w) => /failed to (import|load)/i.test(w))).toEqual([]);
    expect(r.entries.map((e) => e.id)).toEqual(['k.obj', 'k.str']);
    // Carried as written — never split into ['s', 'r', 'c', …].
    expect(r.entries[1]!.references as unknown).toBe('src/a.ts');

    const v = validateKnowledgeEntries(r.entries);
    expect(v.uniqueEntries.map((e) => e.id)).toEqual(['k.obj', 'k.str']);
    const messages = v.issues.filter((i) => i.code === 'invalid-reference').map((i) => i.message);
    expect(messages).toHaveLength(2);
    for (const m of messages) expect(m).toContain('`references` must be a list');
    for (const e of r.entries) expect(knowledgeReferences(e)).toEqual([]);
  });

  test('a list is still copied and frozen', async () => {
    const r = await new TypeScriptKnowledgeLoader().load(
      write(
        'knowledge.ts',
        `import { defineKnowledgeEntry } from ${JSON.stringify(KNOWLEDGE_INDEX)};\n` +
          "export default [defineKnowledgeEntry({ id: 'k.ok', title: 'Ok', type: 'technical', content: 'x', references: [{ kind: 'file', path: 'src/a.ts' }] })];\n",
      ),
    );
    const refs = r.entries[0]!.references!;
    expect(refs).toEqual([{ kind: 'file', path: 'src/a.ts' }]);
    expect(Object.isFrozen(refs)).toBe(true);
    expect(validateKnowledgeEntries(r.entries).issues).toEqual([]);
  });
});

describe('r78 anchors take the references path — kept, reported, never a crash', () => {
  test('a non-list value, a null item and a non-string path are invalid-anchor; the entry is kept', async () => {
    const r = await new TypeScriptKnowledgeLoader().load(
      write(
        'knowledge.ts',
        'export default [\n' +
          "  { id: 'k.map', title: 'M', type: 'technical', content: 'x', anchors: { id: 'a', kind: 'file', path: 'src/a.ts' } },\n" +
          "  { id: 'k.items', title: 'I', type: 'technical', content: 'x', anchors: [null, { id: 'b', kind: 'file', path: ['src/a.ts'] }, { id: 'c', kind: 'file', path: 'src/a.ts' }] },\n" +
          '];\n',
      ),
    );
    const v = validateKnowledgeEntries(r.entries);
    expect(v.uniqueEntries.map((e) => e.id)).toEqual(['k.map', 'k.items']);
    expect(v.issues.filter((i) => i.code === 'invalid-anchor').map((i) => [i.entryId, i.severity, i.message])).toEqual([
      [
        'k.map',
        'error',
        "Entry \"k.map\" `anchors` must be a list (got an object) — write an array — anchors: [{ id: 'a', kind: 'file', path: 'src/a.ts' }].",
      ],
      ['k.items', 'error', 'Entry "k.items" anchor #1 is not an object (got null).'],
      ['k.items', 'error', 'Entry "k.items" anchor #2 has a non-string `path` (got an array).'],
    ]);
    expect(knowledgeAnchors(r.entries[0]!)).toEqual([]);
    expect(knowledgeAnchors(r.entries[1]!).map((a) => a.id)).toEqual(['c']);
  });
});

describe('r78 knowledgeReferenceListing names every item it cannot list', () => {
  test('a Markdown entry with a usable item, a null and a refused string — the validator\'s words, the validator\'s position', async () => {
    const md = await new MarkdownKnowledgeLoader().load(
      write('guide.md', '---\nid: doc.guide\nreferences: [file:src/a.ts, null, bogus:x]\n---\n# Guide\n'),
    );
    expect(md.rejected).toEqual([]);
    const listing = knowledgeReferenceListing(md.entries[0]!);
    expect(listing.references).toEqual([{ kind: 'file', path: 'src/a.ts' }]);
    expect(listing.malformed.map((m) => [m.field, malformedKnowledgeClaimLabel(m), m.value])).toEqual([
      [KnowledgeClaimField.References, 'reference #2', null],
      [KnowledgeClaimField.References, 'reference #3', 'bogus:x'],
    ]);
    const doctor = validateKnowledgeEntries(md.entries).issues.map((i) => i.message);
    for (const m of listing.malformed) {
      expect(doctor).toContain(`Entry "doc.guide" ${malformedKnowledgeClaimLabel(m)} ${m.problem}.`);
    }
  });

  test('a whole non-list value is one malformed claim with no position', async () => {
    const r = await new TypeScriptKnowledgeLoader().load(
      write(
        'knowledge.ts',
        "export default [{ id: 'k.x', title: 'X', type: 'technical', content: 'x', references: 'src/a.ts', anchors: 'a' }];\n",
      ),
    );
    const listing = knowledgeReferenceListing(r.entries[0]!);
    expect(listing.references).toEqual([]);
    expect(listing.anchors).toEqual([]);
    expect(listing.malformed.map((m) => [m.field, m.position, malformedKnowledgeClaimLabel(m)])).toEqual([
      [KnowledgeClaimField.References, undefined, '`references`'],
      [KnowledgeClaimField.Anchors, undefined, '`anchors`'],
    ]);
  });
});
