/**
 * Round 11, 4.2#3 — structured `supersededBy` / `seeAlso`, validated at load
 * and rendered in `knowledge get`.
 *
 * Before: the only way to say "superseded" was prose ("SUPERSEDED — see
 * `app.new-way`"), which nothing checked and which pointed into a dead id; and
 * `formatEntryFull` rendered neither `related` nor `actionHints.relatedKnowledge`.
 * Existence of each id is the inspector's job (the declared cross-reference
 * collector); this layer owns the shape and the rendering.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineKnowledgeEntry } from '../define/define-knowledge-entry.ts';
import { formatEntryFull, projectKnowledgeEntryForJson } from '../format/knowledge-formatter.ts';
import { MarkdownKnowledgeLoader } from '../load/markdown-knowledge-loader.ts';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';
import { validateKnowledgeEntries } from '../validate/validate-knowledge-entries.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function entry(over: Partial<IKnowledgeEntry> & { id: string }): IKnowledgeEntry {
  return {
    title: over.id,
    type: 'architecture',
    priority: 'medium',
    scope: [],
    tags: [],
    appliesWhen: [],
    content: 'Body.',
    ...over,
  };
}

describe('the model carries the fields', () => {
  test('defineKnowledgeEntry keeps and freezes seeAlso / supersededBy', () => {
    const e = defineKnowledgeEntry({
      id: 'app.old',
      title: 'Old',
      type: 'architecture',
      content: 'x',
      seeAlso: ['app.other'],
      supersededBy: ['app.new'],
    });
    expect(e.seeAlso).toEqual(['app.other']);
    expect(e.supersededBy).toEqual(['app.new']);
    expect(Object.isFrozen(e.seeAlso)).toBe(true);
    expect(Object.isFrozen(e.supersededBy)).toBe(true);
    // And the JSON projection (what `knowledge get --json` / MCP serialise) keeps them.
    const json = projectKnowledgeEntryForJson(e);
    expect(json['seeAlso']).toEqual(['app.other']);
    expect(json['supersededBy']).toEqual(['app.new']);
  });

  test('Markdown frontmatter parses both spellings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shrk-r75-xref-md-'));
    dirs.push(dir);
    const a = join(dir, 'a.md');
    writeFileSync(a, '---\nid: app.a\nseeAlso: [app.b, app.c]\nsuperseded-by: app.d\n---\n# A\nBody.\n');
    const b = join(dir, 'b.md');
    writeFileSync(b, '---\nid: app.b\nsee-also: app.a\nsupersededBy: [app.e]\n---\n# B\nBody.\n');
    const loader = new MarkdownKnowledgeLoader();
    const [ea] = (await loader.load(a)).entries;
    const [eb] = (await loader.load(b)).entries;
    expect(ea?.seeAlso).toEqual(['app.b', 'app.c']);
    expect(ea?.supersededBy).toEqual(['app.d']);
    expect(eb?.seeAlso).toEqual(['app.a']);
    expect(eb?.supersededBy).toEqual(['app.e']);
  });
});

describe('load-time validation (shape only)', () => {
  test('an entry that supersedes itself is an error; seeing itself is a warning', () => {
    const r = validateKnowledgeEntries([
      entry({ id: 'app.self', supersededBy: ['app.self'], seeAlso: ['app.self'] }),
    ]);
    const xref = r.issues.filter((i) => i.code === 'invalid-cross-reference');
    expect(xref.map((i) => i.severity).sort()).toEqual(['error', 'warning']);
    expect(xref.find((i) => i.severity === 'error')?.message).toContain('supersededBy');
    expect(r.valid).toBe(false);
  });

  test('a non-string member is an error in the new fields, a warning in the old related', () => {
    const r = validateKnowledgeEntries([
      entry({
        id: 'app.bad',
        supersededBy: [42 as unknown as string],
        seeAlso: [''],
        related: [null as unknown as string],
      }),
    ]);
    const bySeverity = r.issues
      .filter((i) => i.code === 'invalid-cross-reference')
      .map((i) => `${i.severity}:${i.message.includes('supersededBy') ? 'supersededBy' : i.message.includes('seeAlso') ? 'seeAlso' : 'related'}`)
      .sort();
    expect(bySeverity).toEqual(['error:seeAlso', 'error:supersededBy', 'warning:related']);
  });

  test('existence is NOT checked here — a dangling successor loads', () => {
    const r = validateKnowledgeEntries([entry({ id: 'app.old', supersededBy: ['app.nowhere'] })]);
    expect(r.issues.filter((i) => i.code === 'invalid-cross-reference')).toEqual([]);
  });
});

describe('formatEntryFull renders the cross-references', () => {
  const old = entry({
    id: 'app.old',
    title: 'Old way',
    supersededBy: ['app.new'],
    seeAlso: ['fx.rule.one', 'ghost.id'],
    related: ['app.overview'],
    actionHints: { relatedKnowledge: ['app.hinted'] },
  });

  test('without a resolver: the banner and plain ids (back-compat for other callers)', () => {
    const text = formatEntryFull(old);
    const lines = text.split('\n');
    // Directly under the id line, before any content.
    expect(lines[1]).toBe('id: app.old');
    expect(lines[2]).toBe('SUPERSEDED by: app.new  →  shrk knowledge get app.new');
    expect(text).toContain('See also:\n- fx.rule.one\n- ghost.id');
    expect(text).toContain('Related:\n- app.overview');
    // The aggregated-but-never-rendered action-hint field now has a section.
    expect(text).toContain('### Related Knowledge');
    expect(text).toContain('- `app.hinted`');
  });

  test('with a resolver: namespace + title, UNRESOLVED for a dead id, NOT VERIFIED when it could not look', () => {
    const text = formatEntryFull(old, {
      resolveRef: (id) =>
        id === 'app.new'
          ? { kinds: ['knowledge'], title: 'New way' }
          : id === 'fx.rule.one'
            ? { kinds: ['rule', 'knowledge'], title: 'Rule one' }
            : id === 'app.overview'
              ? { kinds: [], unverified: true }
              : { kinds: [] },
    });
    expect(text).toContain('SUPERSEDED by: app.new (knowledge — "New way")  →  shrk knowledge get app.new');
    expect(text).toContain('- fx.rule.one (rule | knowledge — "Rule one")');
    expect(text).toContain('- ghost.id (UNRESOLVED — no registry has this id)');
    expect(text).toContain('- app.overview (NOT VERIFIED — registries not warmed)');
  });

  test('an unresolved successor gets no follow command (it would point at a dead id)', () => {
    const text = formatEntryFull(entry({ id: 'app.x', supersededBy: ['app.gone'] }), { resolveRef: () => ({ kinds: [] }) });
    expect(text).toContain('SUPERSEDED by: app.gone (UNRESOLVED — no registry has this id)');
    expect(text).not.toContain('shrk knowledge get app.gone');
  });
});
