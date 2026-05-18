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
