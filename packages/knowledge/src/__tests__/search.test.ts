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

  test('a relevant title outranks an incidental single-tag hit on a multi-word query', () => {
    // Regression for the full-phrase-only title/summary scoring: a multi-word
    // query never credited a relevant title, so an entry sharing one off-topic
    // tag could win. Per-word title credit fixes it.
    const relevant = defineKnowledgeEntry({
      id: 'cms.catalog-i18n-overlay',
      title: 'Catalog i18n overlay',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.Medium,
      scope: [],
      tags: ['cms'],
      appliesWhen: [],
      content: 'how catalog translations are overlaid',
    });
    const incidental = defineKnowledgeEntry({
      id: 'layout.unit-manifests',
      title: 'Unit manifests',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.Medium,
      scope: [],
      tags: ['catalog'],
      appliesWhen: [],
      content: 'unrelated layout manifest details',
    });
    const results = searchKnowledge([incidental, relevant], {
      query: 'localize product catalog translations currency',
    });
    expect(results[0]?.entry.id).toBe('cms.catalog-i18n-overlay');
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

  test('a critical rule with a weak (appliesWhen) hit outranks a medium lexical match', () => {
    // Regression for the buried-foundational-rule bug: the priority baseline
    // used to be divided by 10, so a Critical rule whose only signal was an
    // appliesWhen match lost to any medium rule that happened to share a
    // keyword. With the full priority weight the governing critical rule wins.
    const foundational = defineKnowledgeEntry({
      id: 'architecture.layer-order',
      title: 'Respect layer order',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.Critical,
      scope: ['architecture'],
      tags: ['architecture'],
      appliesWhen: ['generate-code'],
      content: 'Lower layers cannot import higher.',
    });
    const lexical = defineKnowledgeEntry({
      id: 'plugin.api',
      title: 'API entry point',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.Medium,
      scope: [],
      tags: [],
      appliesWhen: [],
      content: 'the entry point',
    });
    const index = new KnowledgeIndex([lexical, foundational]);
    // Query lexically hits `lexical` on its id only (weight 80) but NOT
    // `foundational`, whose sole signal is the appliesWhen exact match (40).
    // Under the old `/10` baseline the critical rule scored 10+40=50 and lost
    // to the medium's 4+80=84; with the full weight it scores 100+40=140 and
    // correctly wins.
    const results = index.search({ query: 'plugin', appliesWhen: ['generate-code'] });
    expect(results[0]?.entry.id).toBe('architecture.layer-order');
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
