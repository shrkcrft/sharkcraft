import { describe, expect, test } from "bun:test";
import {
  aggregateActionHints,
  defineKnowledgeEntry,
  formatAggregatedHints,
  formatEntryActionHints,
  hasActionHints,
  KnowledgePriority,
  KnowledgeType
} from '../index.ts';

const ruleWithHints = defineKnowledgeEntry({
  id: 'r.high',
  title: 'Rule with hints',
  type: KnowledgeType.Rule,
  priority: KnowledgePriority.High,
  scope: ['ts'],
  tags: ['rule'],
  appliesWhen: ['generate-code'],
  content: '...',
  actionHints: {
    commands: [{ command: 'shrk gen demo a --dry-run', required: true }],
    mcpTools: [{ tool: 'create_generation_plan', required: true }],
    preferredFlow: ['get_relevant_context', 'create_generation_plan', 'human_review'],
    forbiddenActions: ['No writes through MCP.'],
    verificationCommands: ['bun test'],
    relatedTemplates: ['typescript.service'],
    requiresHumanReview: true,
    writePolicy: 'cli-only',
  },
});

const ruleWithoutHints = defineKnowledgeEntry({
  id: 'r.low',
  title: 'Plain rule',
  type: KnowledgeType.Rule,
  priority: KnowledgePriority.Low,
  scope: ['ts'],
  content: '...',
});

const ruleWithDifferentHints = defineKnowledgeEntry({
  id: 'r.critical',
  title: 'Critical rule with different hints',
  type: KnowledgeType.Rule,
  priority: KnowledgePriority.Critical,
  scope: ['ts'],
  content: '...',
  actionHints: {
    preferredFlow: ['this-wins-because-critical'],
    forbiddenActions: ['Do not skip dry-run.'],
    commands: [{ command: 'shrk apply <plan.json>' }],
  },
});

describe('hasActionHints', () => {
  test('true when at least one hint field is present', () => {
    expect(hasActionHints(ruleWithHints)).toBe(true);
  });
  test('false when no hints', () => {
    expect(hasActionHints(ruleWithoutHints)).toBe(false);
  });
});

describe('aggregateActionHints', () => {
  test('unions commands / mcpTools / forbidden / verification across entries', () => {
    const agg = aggregateActionHints([ruleWithHints, ruleWithDifferentHints]);
    expect(agg.commands.map((c) => c.command)).toContain('shrk gen demo a --dry-run');
    expect(agg.commands.map((c) => c.command)).toContain('shrk apply <plan.json>');
    expect(agg.forbiddenActions).toContain('No writes through MCP.');
    expect(agg.forbiddenActions).toContain('Do not skip dry-run.');
  });

  test('preferredFlow comes from the highest-priority entry that defines one', () => {
    const agg = aggregateActionHints([ruleWithHints, ruleWithDifferentHints]);
    expect(agg.preferredFlow).toEqual(['this-wins-because-critical']);
    expect(agg.preferredFlowSourceId).toBe('r.critical');
  });

  test('records contributing entry ids', () => {
    const agg = aggregateActionHints([ruleWithHints, ruleWithoutHints, ruleWithDifferentHints]);
    expect(agg.contributingEntries).toEqual(['r.critical', 'r.high']);
  });

  test('requiresHumanReview ORs across entries', () => {
    const agg = aggregateActionHints([ruleWithHints, ruleWithoutHints]);
    expect(agg.requiresHumanReview).toBe(true);
  });
});

describe('formatAggregatedHints', () => {
  test('renders sections for commands / mcpTools / forbidden / flow', () => {
    const agg = aggregateActionHints([ruleWithHints]);
    const out = formatAggregatedHints(agg, { level: '##' });
    expect(out).toContain('## Recommended MCP Tools');
    expect(out).toContain('## Recommended CLI Commands');
    expect(out).toContain('## Preferred Flow');
    expect(out).toContain('## Forbidden Actions');
    expect(out).toContain('## Verification Commands');
  });

  test('empty when entry has no hints', () => {
    expect(formatEntryActionHints(ruleWithoutHints)).toBe('');
  });
});
