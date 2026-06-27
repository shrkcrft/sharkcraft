import { describe, expect, test } from 'bun:test';
import { projectKnowledgeEntryForJson } from '../format/knowledge-formatter.ts';
import type { IKnowledgeEntry } from '../model/knowledge-entry.ts';

describe('projectKnowledgeEntryForJson', () => {
  test('serialises authored fields even when they are NON-ENUMERABLE', () => {
    // A pack may ship an entry model whose fields are getters / non-enumerable
    // (compiled output, class/proxy-backed). A `{ ...entry }` spread would strip
    // those, leaving an "empty"-looking JSON entry. Direct projection must not.
    const entry = {} as IKnowledgeEntry;
    const fields: Record<string, unknown> = {
      id: 'pack.one',
      title: 'Pack entry one',
      type: 'technical',
      priority: 'high',
      scope: ['cms'],
      tags: ['blocks'],
      appliesWhen: ['authoring'],
      content: 'The full authored body.',
    };
    for (const [k, v] of Object.entries(fields)) {
      Object.defineProperty(entry, k, { value: v, enumerable: false });
    }
    // Sanity: a spread would lose everything (proves the bug the fix guards).
    expect(Object.keys({ ...entry })).toEqual([]);

    const projected = projectKnowledgeEntryForJson(entry);
    // Round-trip through JSON to mirror the CLI path.
    const round = JSON.parse(JSON.stringify(projected));
    expect(round.id).toBe('pack.one');
    expect(round.title).toBe('Pack entry one');
    expect(round.scope).toEqual(['cms']);
    expect(round.tags).toEqual(['blocks']);
    expect(round.content).toBe('The full authored body.');
  });

  test('drops undefined optionals (no null noise in JSON)', () => {
    const entry: IKnowledgeEntry = {
      id: 'x',
      title: 'X',
      type: 'technical',
      priority: 'low',
      scope: [],
      tags: [],
      appliesWhen: [],
      content: 'c',
    };
    const round = JSON.parse(JSON.stringify(projectKnowledgeEntryForJson(entry)));
    expect('summary' in round).toBe(false);
    expect('metadata' in round).toBe(false);
    expect(round.id).toBe('x');
  });
});
