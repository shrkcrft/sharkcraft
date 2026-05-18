import { describe, expect, test } from 'bun:test';
import {
  defineKnowledgeEntry,
  KnowledgePriority,
  KnowledgeType,
  validateKnowledgeEntries,
} from '../index.ts';

describe('validateKnowledgeEntries', () => {
  test('returns valid:true for a clean list', () => {
    const entries = [
      defineKnowledgeEntry({
        id: 'a.b',
        title: 'A',
        type: KnowledgeType.Rule,
        priority: KnowledgePriority.High,
        content: 'a',
      }),
      defineKnowledgeEntry({
        id: 'c.d',
        title: 'C',
        type: KnowledgeType.Path,
        priority: KnowledgePriority.Medium,
        content: 'c',
      }),
    ];
    const result = validateKnowledgeEntries(entries);
    expect(result.valid).toBe(true);
    expect(result.issues.length).toBe(0);
    expect(result.uniqueEntries.length).toBe(2);
  });

  test('flags duplicate ids (warning, first wins)', () => {
    const a1 = defineKnowledgeEntry({
      id: 'dup',
      title: 'First',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.High,
      content: 'first',
    });
    const a2 = defineKnowledgeEntry({
      id: 'dup',
      title: 'Second',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.High,
      content: 'second',
    });
    const result = validateKnowledgeEntries([a1, a2]);
    expect(result.valid).toBe(true); // duplicates are warnings, not errors
    expect(result.issues.some((i) => i.code === 'duplicate-id')).toBe(true);
    expect(result.uniqueEntries.length).toBe(1);
    expect(result.uniqueEntries[0]?.title).toBe('First');
  });

  test('flags invalid priority as error', () => {
    const entry = defineKnowledgeEntry({
      id: 'a.b',
      title: 'A',
      type: KnowledgeType.Rule,
      priority: 'extreme', // invalid
      content: 'a',
    });
    const result = validateKnowledgeEntries([entry]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'invalid-priority')).toBe(true);
  });

  test('flags missing id', () => {
    // Bypass defineKnowledgeEntry which would throw — construct the bad entry directly.
    const bad = {
      id: '',
      title: 'Title',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.High,
      scope: [],
      tags: [],
      appliesWhen: [],
      content: 'x',
    } as never;
    const result = validateKnowledgeEntries([bad]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'missing-id')).toBe(true);
  });
});
