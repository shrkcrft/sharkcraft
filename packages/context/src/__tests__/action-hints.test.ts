import { describe, expect, test } from "bun:test";
import { defineKnowledgeEntry, KnowledgePriority, KnowledgeType } from '@shrkcrft/knowledge';
import { buildContext } from '../index.ts';

const entries = [
  defineKnowledgeEntry({
    id: 'rule.safety',
    title: 'Generation safety',
    type: KnowledgeType.Warning,
    priority: KnowledgePriority.Critical,
    scope: ['ts'],
    tags: ['safety'],
    appliesWhen: ['generate-code'],
    content: 'no writes via MCP.',
    actionHints: {
      commands: [{ command: 'shrk apply <plan.json>', required: true }],
      mcpTools: [{ tool: 'create_generation_plan', required: true }],
      preferredFlow: ['create_generation_plan', 'human_review', 'shrk apply'],
      forbiddenActions: ['Do not write through MCP.'],
      verificationCommands: ['bun test'],
      requiresHumanReview: true,
      writePolicy: 'cli-only',
    },
  }),
  defineKnowledgeEntry({
    id: 'rule.naming',
    title: 'Class naming',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    scope: ['ts'],
    tags: ['naming'],
    appliesWhen: ['generate-code'],
    content: 'PascalCase.',
  }),
];

describe('context builder surfaces action hints', () => {
  test('emits an Agent Actions section', () => {
    const result = buildContext(entries, { task: 'generate code', maxTokens: 4000 });
    const titles = result.sections.map((s) => s.title);
    expect(titles).toContain('Agent Actions');
  });

  test('Agent Actions includes commands / MCP tools / forbidden / verification', () => {
    const result = buildContext(entries, { task: 'generate code', maxTokens: 4000 });
    const section = result.sections.find((s) => s.title === 'Agent Actions');
    expect(section).toBeDefined();
    const body = section!.body;
    expect(body).toContain('Recommended MCP Tools');
    expect(body).toContain('create_generation_plan');
    expect(body).toContain('Recommended CLI Commands');
    expect(body).toContain('shrk apply');
    expect(body).toContain('Forbidden Actions');
    expect(body).toContain('Verification Commands');
    expect(body).toContain('Human Review Points');
  });

  test('contributingEntries are tracked', () => {
    const result = buildContext(entries, { task: 'generate code', maxTokens: 4000 });
    const section = result.sections.find((s) => s.title === 'Agent Actions');
    expect(section?.entryIds).toContain('rule.safety');
  });

  test('Agent Actions survives budget pruning; a lower-priority section drops first', () => {
    const big = 'detail '.repeat(400);
    const corpus = [
      entries[0]!, // rule.safety — Warning + actionHints, drives Agent Actions
      defineKnowledgeEntry({
        id: 'tech.a',
        title: 'Tech A',
        type: KnowledgeType.Technical,
        priority: KnowledgePriority.Low,
        scope: ['ts'],
        tags: ['stack'],
        appliesWhen: ['generate-code'],
        content: big,
      }),
      defineKnowledgeEntry({
        id: 'tech.b',
        title: 'Tech B',
        type: KnowledgeType.Technical,
        priority: KnowledgePriority.Low,
        scope: ['ts'],
        tags: ['stack'],
        appliesWhen: ['generate-code'],
        content: big,
      }),
    ];
    const result = buildContext(corpus, { task: 'generate code', maxTokens: 400 });
    const titles = result.sections.map((s) => s.title);
    // Agent Actions (priority 92) survives; the low-priority Technical Stack
    // section (priority 50) is the one dropped — under the old append-after-loop
    // ordering, Agent Actions was the first thing cut.
    expect(titles).toContain('Agent Actions');
    expect(result.omittedSections.length).toBeGreaterThan(0);
    expect(result.omittedSections).not.toContain('Agent Actions');
  });

  test('no Agent Actions section when no entry has hints', () => {
    const noHints = [
      defineKnowledgeEntry({
        id: 'plain.a',
        title: 'plain',
        type: KnowledgeType.Rule,
        priority: KnowledgePriority.Medium,
        content: 'x',
      }),
    ];
    const result = buildContext(noHints, { task: 'x', maxTokens: 1000 });
    expect(result.sections.find((s) => s.title === 'Agent Actions')).toBeUndefined();
  });
});
