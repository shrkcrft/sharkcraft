import { describe, expect, test } from 'bun:test';
import {
  defineKnowledgeEntry,
  KnowledgeIndex,
  KnowledgePriority,
  KnowledgeType,
  searchKnowledge,
  filterKnowledge,
} from '../index.ts';

const entries = [
  defineKnowledgeEntry({
    id: 'typescript.naming.classes',
    title: 'Class naming',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    scope: ['typescript'],
    tags: ['typescript', 'naming'],
    appliesWhen: ['generate-code', 'create-service'],
    content: 'Classes use PascalCase.',
  }),
  defineKnowledgeEntry({
    id: 'app.services',
    title: 'Services path',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    scope: ['typescript', 'backend'],
    tags: ['service'],
    appliesWhen: ['generate-service'],
    content: 'src/services',
  }),
  defineKnowledgeEntry({
    id: 'safety.generation',
    title: 'Generation safety',
    type: KnowledgeType.Warning,
    priority: KnowledgePriority.Critical,
    scope: ['generation'],
    tags: ['safety'],
    appliesWhen: ['generate-code'],
    content: 'Never write without --write.',
  }),
];

describe('searchKnowledge', () => {
  test('finds entries by free-text id substring', () => {
    const results = searchKnowledge(entries, { query: 'naming' });
    expect(results[0]?.entry.id).toBe('typescript.naming.classes');
  });

  test('filters by type', () => {
    const results = searchKnowledge(entries, { types: [KnowledgeType.Path] });
    expect(results.length).toBe(1);
    expect(results[0]?.entry.id).toBe('app.services');
  });

  test('returns reasons for matches', () => {
    const results = searchKnowledge(entries, { query: 'naming' });
    const top = results[0];
    expect(top).toBeDefined();
    expect(top!.reasons.some((r) => r.match === 'naming')).toBe(true);
  });

  test('respects appliesWhen exact match bonus', () => {
    const results = searchKnowledge(entries, {
      appliesWhen: ['generate-service'],
      query: 'service',
    });
    expect(results[0]?.entry.id).toBe('app.services');
  });

  test('returns empty when no filters or query matches', () => {
    const results = searchKnowledge(entries, { query: 'completely-unrelated-zzz' });
    expect(results.length).toBe(0);
  });

  test('respects limit', () => {
    const results = searchKnowledge(entries, { query: 'a', limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe('filterKnowledge', () => {
  test('filters by tags (AND)', () => {
    const filtered = filterKnowledge(entries, { tags: ['typescript', 'naming'] });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.id).toBe('typescript.naming.classes');
  });

  test('filters by scope (any-match)', () => {
    const filtered = filterKnowledge(entries, { scope: ['backend'] });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.id).toBe('app.services');
  });
});

describe('KnowledgeIndex', () => {
  test('deduplicates entries by id', () => {
    const dup = defineKnowledgeEntry({
      id: 'app.services',
      title: 'Dup',
      type: KnowledgeType.Path,
      priority: KnowledgePriority.Low,
      content: 'dup',
    });
    const index = new KnowledgeIndex([entries[0]!, entries[1]!, dup]);
    expect(index.size()).toBe(2);
    // First definition wins.
    expect(index.get('app.services')?.title).toBe('Services path');
  });

  test('search prioritizes critical entries', () => {
    const index = new KnowledgeIndex(entries);
    const results = index.search({ query: 'generation' });
    expect(results[0]?.entry.id).toBe('safety.generation');
  });
});

describe('defineKnowledgeEntry validation', () => {
  test('rejects missing id', () => {
    expect(() =>
      defineKnowledgeEntry({
        id: '',
        title: 'x',
        type: 'rule',
        content: 'x',
      } as never),
    ).toThrow();
  });

  test('rejects invalid id format', () => {
    expect(() =>
      defineKnowledgeEntry({
        id: 'Bad Id With Spaces',
        title: 'x',
        type: 'rule',
        content: 'x',
      }),
    ).toThrow();
  });
});
