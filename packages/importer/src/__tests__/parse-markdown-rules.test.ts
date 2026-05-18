import { describe, expect, test } from 'bun:test';
import { KnowledgePriority, KnowledgeType } from '@shrkcrft/knowledge';
import { parseMarkdownRules } from '../parse/parse-markdown-rules.ts';

describe('parseMarkdownRules', () => {
  test('parses bullets under headings into separate entries', () => {
    const md = [
      '# Coding Standards',
      '',
      '- Always use 2-space indentation.',
      '- Prefer interfaces over type aliases.',
    ].join('\n');
    const entries = parseMarkdownRules(md, { origin: 'CLAUDE.md', idPrefix: 'claude' });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.title).toBe('Always use 2-space indentation');
    expect(entries[0]!.priority).toBe(KnowledgePriority.High);
    expect(entries[0]!.tags).toContain('coding');
  });

  test('infers type from heading keywords', () => {
    const md = [
      '## Security',
      '- Validate all input.',
      '## Paths',
      '- Services live in `src/services/`.',
    ].join('\n');
    const entries = parseMarkdownRules(md, { origin: 'AGENTS.md', idPrefix: 'agents' });
    const sec = entries.find((e) => /Validate all input/.test(e.title));
    const path = entries.find((e) => /Services live/.test(e.title));
    expect(sec?.type).toBe(KnowledgeType.Security);
    expect(path?.type).toBe(KnowledgeType.Path);
  });

  test('disambiguates duplicate ids per origin', () => {
    const md = [
      '## Section A',
      '- Do the thing.',
      '## Section A',
      '- Do the thing.',
    ].join('\n');
    const entries = parseMarkdownRules(md, { origin: 'x.md', idPrefix: 'x' });
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
  });

  test('falls back to paragraphs when no bullets are present', () => {
    const md = ['## Overview', 'This service handles user profiles.'].join('\n');
    const entries = parseMarkdownRules(md, { origin: 'x.md', idPrefix: 'x' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toContain('handles user profiles');
  });
});
