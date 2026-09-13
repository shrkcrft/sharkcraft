/**
 * Round 11 §3.2 — an entry literal without `appliesWhen` (or `tags` / `scope`)
 * loaded and validated, then crashed `shrk knowledge get` on
 * `entry.appliesWhen.length`. The TypeScript loader now normalises the three
 * list fields (as `defineKnowledgeEntry` always did), a non-list value is
 * replaced with a warning, and the formatters read them defensively.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatEntryCompact, formatEntryFull, TypeScriptKnowledgeLoader, type IKnowledgeEntry } from '../index.ts';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function file(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'shrk-r75-lists-'));
  roots.push(dir);
  const p = join(dir, 'knowledge.ts');
  writeFileSync(p, body);
  return p;
}

describe('TypeScriptKnowledgeLoader — list fields', () => {
  test('a literal without tags / scope / appliesWhen loads with frozen [] for each, and formats', async () => {
    const p = file(
      "export const bare = { id: 'k.bare', title: 'Bare', type: 'technical', priority: 'low', content: 'No lists.' };\n",
    );
    const r = await new TypeScriptKnowledgeLoader().load(p);
    const e = r.entries[0]!;
    expect([e.tags, e.scope, e.appliesWhen]).toEqual([[], [], []]);
    expect(Object.isFrozen(e.appliesWhen)).toBe(true);
    // Missing lists are the documented default — no warning.
    expect(r.warnings.filter((w) => w.includes('non-list'))).toEqual([]);
    expect(() => formatEntryFull(e)).not.toThrow();
    expect(formatEntryFull(e)).toContain('# Bare');
    expect(formatEntryCompact(e)).toBe('k.bare (technical, low) — Bare');
  });

  test('a non-list value is replaced by [] with a warning naming the entry and field', async () => {
    const p = file(
      "export const s = { id: 'k.string-tags', title: 'S', type: 'technical', priority: 'low', content: 'x', tags: 'a,b', scope: [], appliesWhen: [] };\n",
    );
    const r = await new TypeScriptKnowledgeLoader().load(p);
    expect(r.entries[0]!.tags).toEqual([]);
    expect(r.warnings.find((w) => w.includes('"k.string-tags"'))).toContain('non-list `tags` (string)');
  });
});

describe('the formatters never crash on a missing list', () => {
  test('a frozen entry that no loader normalised', () => {
    const frozen = Object.freeze({ id: 'k.f', title: 'F', type: 'technical', priority: 'low', content: 'c' });
    const e = frozen as unknown as IKnowledgeEntry;
    expect(() => formatEntryFull(e)).not.toThrow();
    expect(formatEntryCompact(e)).toBe('k.f (technical, low) — F');
  });
});
