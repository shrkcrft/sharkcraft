import { describe, expect, test } from 'bun:test';
import { KnowledgePriority } from '@shrkcrft/knowledge';
import { parseCursorRuleFile } from '../parse/parse-cursor-rule.ts';

describe('parseCursorRuleFile', () => {
  test('extracts description, tags, and priority from frontmatter', () => {
    const raw = [
      '---',
      'description: Use bun test only',
      'tags: [testing, bun]',
      'priority: critical',
      '---',
      '',
      '- Do not introduce Jest.',
    ].join('\n');
    const e = parseCursorRuleFile(raw, { origin: '.cursor/rules/testing.mdc', idPrefix: 'cursor.testing' });
    expect(e.title).toBe('Use bun test only');
    expect(e.priority).toBe(KnowledgePriority.Critical);
    expect(e.tags).toContain('testing');
    expect(e.content).toContain('Do not introduce Jest');
  });

  test('survives missing frontmatter (treats body as content)', () => {
    const raw = '- Just a rule.';
    const e = parseCursorRuleFile(raw, { origin: 'x.mdc', idPrefix: 'cursor.x' });
    expect(e.content).toBe('- Just a rule.');
    expect(e.priority).toBe(KnowledgePriority.Medium);
  });

  test('parses glob patterns into tag-friendly form', () => {
    const raw = [
      '---',
      'description: TS only',
      'globs: ["**/*.ts"]',
      '---',
      'rule.',
    ].join('\n');
    const e = parseCursorRuleFile(raw, { origin: 'x.mdc', idPrefix: 'cursor.x' });
    expect(e.tags.some((t) => t.includes('ts'))).toBe(true);
  });
});
