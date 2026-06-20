import { describe, expect, test } from 'bun:test';
import type { IKnowledgeEntry } from '@shrkcrft/knowledge';
import { defineRule } from '../rule.ts';
import { formatRuleCompact, formatRuleFull, formatRulesForAi } from '../rule-formatter.ts';

describe('rule formatters', () => {
  const rule = defineRule({
    id: 'no-any',
    title: 'Avoid any',
    content: '  Use precise types instead of any.  ',
  });

  test('formatRulesForAi numbers entries and trims content', () => {
    const out = formatRulesForAi([rule]);
    expect(out).toContain('1. [no-any] Avoid any');
    expect(out).toContain('Use precise types instead of any.');
    expect(out).not.toContain('any.  '); // trailing whitespace trimmed off the content
  });

  test('empty input returns the sentinel string', () => {
    expect(formatRulesForAi([])).toBe('No relevant rules found.');
  });

  test('multiple rules are blank-line separated and 1-indexed', () => {
    const second = defineRule({ id: 'no-todo', title: 'No TODOs', content: 'Resolve TODOs before merge.' });
    const out = formatRulesForAi([rule, second]);
    expect(out).toContain('2. [no-todo] No TODOs');
    expect(out.split('\n\n').length).toBe(2);
  });

  test('an entry with missing title/content is rendered defensively (no throw)', () => {
    const malformed = { id: 'bad', tags: [], scope: [], appliesWhen: [] } as unknown as IKnowledgeEntry;
    const out = formatRulesForAi([malformed]);
    expect(out).toContain('[bad]');
    expect(out).toContain('(untitled)');
  });

  test('formatRuleCompact / formatRuleFull produce non-empty output', () => {
    expect(formatRuleCompact(rule).length).toBeGreaterThan(0);
    expect(formatRuleFull(rule).length).toBeGreaterThan(0);
  });
});
