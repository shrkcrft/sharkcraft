/**
 * r78 — a reference's `required` is a boolean, the same for a TypeScript and a
 * Markdown item (round 15 follow-up, F10).
 *
 * Before: `required: 'yes'` (TypeScript) or `required: yes` (a Markdown map
 * item — the frontmatter parser reads it as the string `"yes"`) validated clean
 * and read as NOT required, so `--ci` / `--strict` waived the very reference
 * the author meant to block on. It is now malformed through THE item-shape
 * predicate (`referenceShapeProblem`) the validator and the stale-check both
 * apply: one `invalid-reference` error, one message, whatever the format.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import { MarkdownKnowledgeLoader } from '../load/markdown-knowledge-loader.ts';
import { referenceShapeProblem } from '../validate/reference-shape-problem.ts';
import { validateKnowledgeEntries } from '../validate/validate-knowledge-entries.ts';

const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-required-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PROBLEM = 'has a non-boolean `required` (got "yes") — write required: true or required: false';

function tsEntry(required: unknown): IKnowledgeEntry {
  return {
    id: 'k.req',
    title: 'Req',
    type: 'technical',
    priority: 'low',
    scope: [],
    tags: [],
    appliesWhen: [],
    content: 'x',
    references: [{ kind: 'file', path: 'src/a.ts', required } as never],
  } as IKnowledgeEntry;
}

async function mdEntry(requiredLine: string): Promise<IKnowledgeEntry> {
  const file = join(dir, `req-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, `---\nid: doc.req\ntitle: Req\nreferences:\n  - kind: file\n    path: src/a.ts\n    ${requiredLine}\n---\n# Req\n`);
  const loaded = await new MarkdownKnowledgeLoader().load(file);
  expect(loaded.rejected ?? []).toEqual([]);
  return loaded.entries[0]!;
}

describe('r78 F10 — `required` must be a boolean', () => {
  test('the one shape predicate: a string, a number or null is malformed; true / false / absent are not', () => {
    expect(referenceShapeProblem({ kind: 'file', path: 'src/a.ts', required: 'yes' })).toBe(PROBLEM);
    expect(referenceShapeProblem({ kind: 'file', path: 'src/a.ts', required: 1 })).toContain('has a non-boolean `required` (got 1)');
    expect(referenceShapeProblem({ kind: 'file', path: 'src/a.ts', required: null })).toContain('has a non-boolean `required`');
    for (const ok of [true, false, undefined]) {
      expect(referenceShapeProblem({ kind: 'file', path: 'src/a.ts', ...(ok === undefined ? {} : { required: ok }) })).toBeUndefined();
    }
  });

  test("TypeScript `required: 'yes'` and Markdown `required: yes` are the SAME invalid-reference error", async () => {
    const md = await mdEntry('required: yes');
    expect((md.references ?? [])[0]).toMatchObject({ kind: 'file', path: 'src/a.ts', required: 'yes' });
    const issues = validateKnowledgeEntries([tsEntry('yes'), md]).issues.filter((i) => i.code === 'invalid-reference');
    expect(issues.map((i) => [i.entryId, i.severity, i.message])).toEqual([
      ['k.req', 'error', `Entry "k.req" reference #1 ${PROBLEM}.`],
      ['doc.req', 'error', `Entry "doc.req" reference #1 ${PROBLEM}.`],
    ]);
  });

  test('Markdown `required: true` / `false` read as booleans and validate clean', async () => {
    for (const [line, want] of [
      ['required: true', true],
      ['required: false', false],
    ] as const) {
      const md = await mdEntry(line);
      expect((md.references ?? [])[0]?.required).toBe(want);
      expect(validateKnowledgeEntries([md]).issues.filter((i) => i.code === 'invalid-reference')).toEqual([]);
    }
  });
});
