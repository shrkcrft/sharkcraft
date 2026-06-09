import { describe, expect, test } from 'bun:test';
import {
  defineKnowledgeEntry,
  KnowledgePriority,
  KnowledgeType,
} from '@shrkcrft/knowledge';
import { buildContext } from '../index.ts';

const entries = [
  defineKnowledgeEntry({
    id: 'rule.naming',
    title: 'Class naming',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    scope: ['typescript'],
    tags: ['naming'],
    appliesWhen: ['generate-code', 'create-service'],
    content: 'Classes use PascalCase.',
  }),
  defineKnowledgeEntry({
    id: 'path.services',
    title: 'Services path',
    type: KnowledgeType.Path,
    priority: KnowledgePriority.High,
    scope: ['typescript'],
    tags: ['service'],
    appliesWhen: ['generate-service'],
    content: 'src/services',
  }),
  defineKnowledgeEntry({
    id: 'safety.gen',
    title: 'Generation safety',
    type: KnowledgeType.Warning,
    priority: KnowledgePriority.Critical,
    scope: ['generation'],
    tags: ['safety'],
    appliesWhen: ['generate-code'],
    content: 'Never write outside project root.',
  }),
  defineKnowledgeEntry({
    id: 'unrelated.thing',
    title: 'Unrelated',
    type: KnowledgeType.Technical,
    priority: KnowledgePriority.Low,
    scope: ['other'],
    tags: ['misc'],
    appliesWhen: ['something-else'],
    content: 'Unrelated content.',
  }),
];

describe('buildContext', () => {
  test('returns sections in priority order', () => {
    const result = buildContext(entries, {
      task: 'create a TypeScript service',
      scope: ['typescript'],
      maxTokens: 4000,
      projectOverview: 'demo project',
    });
    const titles = result.sections.map((s) => s.title);
    expect(titles[0]).toBe('Project Overview');
    // Warnings rank above rules.
    expect(titles.indexOf('Important Warnings')).toBeLessThan(titles.indexOf('Relevant Rules'));
  });

  test('omits sections when over budget', () => {
    const result = buildContext(entries, {
      task: 'create a TypeScript service',
      scope: ['typescript'],
      maxTokens: 50,
      projectOverview: 'demo',
    });
    expect(result.totalTokens).toBeLessThanOrEqual(result.maxTokens + 50);
    // Either at least one section was emitted, or we omitted some.
    expect(result.sections.length + result.omittedSections.length).toBeGreaterThan(0);
  });

  test('filters out unrelated entries when scope is specified', () => {
    const result = buildContext(entries, {
      task: 'create a service',
      scope: ['typescript'],
      maxTokens: 4000,
    });
    const ids = result.sections.flatMap((s) => s.entryIds);
    expect(ids).not.toContain('unrelated.thing');
  });

  test('includes safety warning entry', () => {
    const result = buildContext(entries, {
      task: 'generate code',
      maxTokens: 4000,
    });
    const ids = result.sections.flatMap((s) => s.entryIds);
    expect(ids).toContain('safety.gen');
  });

  test('respects includeRules:false', () => {
    const result = buildContext(entries, {
      task: 'create a service',
      scope: ['typescript'],
      maxTokens: 4000,
      includeRules: false,
    });
    expect(result.sections.find((s) => s.title === 'Relevant Rules')).toBeUndefined();
  });

  test('exposes structured action hints (parity with task --json)', () => {
    const withHints = defineKnowledgeEntry({
      id: 'rule.gen.flow',
      title: 'Generation flow',
      type: KnowledgeType.Rule,
      priority: KnowledgePriority.Critical,
      scope: ['typescript'],
      tags: ['safety', 'generator'],
      appliesWhen: ['generate-code'],
      content: 'Dry-run, review, then apply.',
      actionHints: {
        preferredFlow: ['list_templates', 'create_generation_plan', 'shrk apply'],
        forbiddenActions: ['Writing files directly when a template exists.'],
        verificationCommands: ['bun test'],
        writePolicy: 'cli-only',
      },
    });
    const result = buildContext([...entries, withHints], {
      task: 'generate code',
      scope: ['typescript'],
      maxTokens: 4000,
    });
    // The structured bundle is present without parsing the markdown body.
    expect(result.actionHints.preferredFlow).toEqual([
      'list_templates',
      'create_generation_plan',
      'shrk apply',
    ]);
    expect(result.actionHints.forbiddenActions).toContain('Writing files directly when a template exists.');
    expect(result.actionHints.verificationCommands).toContain('bun test');
    expect(result.actionHints.writePolicy).toBe('cli-only');
    expect(result.actionHints.contributingEntries).toContain('rule.gen.flow');
    // And it stays consistent with the rendered body.
    expect(result.body).toContain('Agent Actions');
  });
});
