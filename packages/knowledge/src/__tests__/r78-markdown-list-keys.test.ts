/**
 * r78 — a Markdown knowledge field that holds ONE value reads an inline `[…]`
 * as its text (round 15 closing).
 *
 * The round-15 frontmatter parser read every inline `[…]` as a flow list, so a
 * document titled `title: [WIP]` was REFUSED ("title: must be a single value
 * (got a list)") where the pre-round-15 line reader loaded it with the title
 * `[WIP]`. The decision and `.mdc` readers were fixed with the parser's
 * `listKeys` option; the Markdown knowledge loader now declares its list fields
 * the same way. Its list fields still take inline lists.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownKnowledgeLoader } from '../index.ts';

const dir = mkdtempSync(join(tmpdir(), 'shrk-r78-mdlistkeys-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function load(name: string, text: string) {
  const file = join(dir, name);
  writeFileSync(file, text);
  const loaded = await new MarkdownKnowledgeLoader().load(file);
  return { entries: loaded.entries, rejected: loaded.rejected ?? [] };
}

describe('r78 Markdown knowledge — list fields vs one-value fields', () => {
  test('`title: [WIP]` is the title "[WIP]", not a refused one-item list', async () => {
    const r = await load('wip.md', '---\nid: doc.wip\ntitle: [WIP]\n---\n# WIP\n\nBody.\n');
    expect(r.rejected).toEqual([]);
    expect(r.entries.map((e) => ({ id: e.id, title: e.title }))).toEqual([{ id: 'doc.wip', title: '[WIP]' }]);
  });

  test('`title: [WIP] draft` and a bracketed summary read verbatim', async () => {
    const r = await load('wip-draft.md', '---\nid: doc.wip-draft\ntitle: [WIP] draft\nsummary: [RFC] adopt [Bun]\n---\nBody.\n');
    expect(r.rejected).toEqual([]);
    expect(r.entries[0]!.title).toBe('[WIP] draft');
    expect(r.entries[0]!.summary).toBe('[RFC] adopt [Bun]');
  });

  test('list fields still take inline lists', async () => {
    const r = await load('lists.md', '---\nid: doc.lists\ntitle: Lists\ntags: [a, b]\nscope: [packages/core]\n---\nBody.\n');
    expect(r.rejected).toEqual([]);
    expect(r.entries[0]!.tags).toEqual(['a', 'b']);
    expect(r.entries[0]!.scope).toEqual(['packages/core']);
  });

  test('every field the loader reads as a list is declared in ENTRY_LIST_KEYS, and no other', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'load', 'markdown-knowledge-loader.ts'), 'utf8');
    const declared = /const ENTRY_LIST_KEYS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)?.[1];
    expect(declared).toBeDefined();
    const declaredKeys = [...declared!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
    const readAsList = [...new Set([...src.matchAll(/read\.list\('([^']+)'\)/g)].map((m) => m[1]!))].sort();
    expect(readAsList.length).toBeGreaterThan(0);
    expect(declaredKeys).toEqual(readAsList);
  });
});
