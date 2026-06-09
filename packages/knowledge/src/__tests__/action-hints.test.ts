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

describe('aggregateActionHints tolerates malformed authoring', () => {
  // A common typo is to author a single-value field as a scalar string
  // (`preferredFlow: 'x'`) instead of an array. A string has `.length` but no
  // `.map`, which used to crash the formatter (`preferredFlow.map is not a
  // function`) and take down the whole `shrk context` entrypoint.
  const malformed = {
    id: 'r.scalar-flow',
    title: 'Scalar preferredFlow',
    type: KnowledgeType.Rule,
    priority: KnowledgePriority.High,
    scope: ['ts'],
    content: '...',
    actionHints: {
      preferredFlow: 'list_templates -> apply',
      forbiddenActions: 'do not write through MCP',
      commands: 'shrk gen',
      verificationCommands: ['bun test', 42, 'tsc'],
    },
    // Bypass the typed surface to simulate hand-authored / imported data.
  } as unknown as Parameters<typeof aggregateActionHints>[0][number];

  test('coerces a scalar preferredFlow into a single-element array', () => {
    const agg = aggregateActionHints([malformed]);
    expect(agg.preferredFlow).toEqual(['list_templates -> apply']);
    expect(agg.preferredFlowSourceId).toBe('r.scalar-flow');
  });

  test('coerces a scalar string-array field into a single-element array', () => {
    const agg = aggregateActionHints([malformed]);
    expect(agg.forbiddenActions).toEqual(['do not write through MCP']);
  });

  test('ignores a scalar authored where an object array is expected', () => {
    const agg = aggregateActionHints([malformed]);
    expect(agg.commands).toEqual([]);
  });

  test('drops non-string members of an array field', () => {
    const agg = aggregateActionHints([malformed]);
    expect(agg.verificationCommands).toEqual(['bun test', 'tsc']);
  });

  test('formatAggregatedHints does not throw on malformed input', () => {
    const agg = aggregateActionHints([malformed]);
    expect(() => formatAggregatedHints(agg, { level: '###', compact: true })).not.toThrow();
    const out = formatAggregatedHints(agg, { level: '###', compact: true });
    expect(out).toContain('### Preferred Flow');
    expect(out).toContain('1. list_templates -> apply');
  });
});
