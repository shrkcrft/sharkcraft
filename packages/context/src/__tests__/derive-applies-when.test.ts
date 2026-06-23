import { describe, expect, test } from 'bun:test';
import {
  defineKnowledgeEntry,
  KnowledgePriority,
  KnowledgeType,
} from '@shrkcrft/knowledge';
import { buildContext, deriveAppliesWhen } from '../index.ts';

describe('deriveAppliesWhen', () => {
  test('maps create/add verbs to generate-code', () => {
    expect(deriveAppliesWhen('add a new plugin command')).toContain('generate-code');
  });

  test('maps domain tokens (service) to their appliesWhen', () => {
    expect(deriveAppliesWhen('create a new service')).toContain('generate-service');
  });

  test('returns nothing for a verb-less / domain-less task', () => {
    expect(deriveAppliesWhen('completely unrelated zzz qqq')).toEqual([]);
  });

  test('is deterministic + sorted', () => {
    expect(deriveAppliesWhen('add a service')).toEqual(deriveAppliesWhen('add a service'));
    const out = deriveAppliesWhen('add and review a service');
    expect([...out]).toEqual([...out].sort());
  });
});

describe('buildContext surfaces foundational rules via derived appliesWhen', () => {
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
  const noise = defineKnowledgeEntry({
    id: 'plugin.command.naming',
    title: 'Plugin command naming',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.Medium,
    scope: [],
    tags: [],
    appliesWhen: [],
    content: 'Name plugin commands clearly.',
  });

  test('a foundational critical rule appears for a task with no lexical overlap', () => {
    const result = buildContext([noise, foundational], {
      task: 'add a new plugin command to the plugin-api',
    });
    const ruleIds = result.sections
      .filter((s) => s.title === 'Relevant Rules')
      .flatMap((s) => s.entryIds);
    expect(ruleIds).toContain('architecture.layer-order');
  });

  test('an unrelated task does not surface the foundational rule', () => {
    const result = buildContext([noise, foundational], {
      task: 'completely unrelated zzz qqq',
    });
    const ruleIds = result.sections
      .filter((s) => s.title === 'Relevant Rules')
      .flatMap((s) => s.entryIds);
    expect(ruleIds).not.toContain('architecture.layer-order');
  });
});
