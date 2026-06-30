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

  test('parses CRLF-authored markdown without dropping rules (Windows files)', () => {
    const md = ['# Coding Standards', '', '- Use 2-space indentation.', '- Prefer interfaces.'].join('\r\n');
    const entries = parseMarkdownRules(md, { origin: 'CLAUDE.md', idPrefix: 'claude' });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.title).toBe('Use 2-space indentation');
    expect(entries[0]!.tags).toContain('coding');
  });

  test('parses a flat heading-less bullet list into one entry per bullet', () => {
    // The most common AGENTS.md shape: no headings, just a top-level list.
    const md = [
      '- Always use 2-space indentation.',
      '- Prefer interfaces over type aliases.',
      '- Never commit secrets.',
    ].join('\n');
    const entries = parseMarkdownRules(md, { origin: 'AGENTS.md', idPrefix: 'agents' });
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.title)).toEqual([
      'Always use 2-space indentation',
      'Prefer interfaces over type aliases',
      'Never commit secrets',
    ]);
    // Entries present → the api-layer "No bullet rules ..." warning will not fire.
    expect(entries.length).toBeGreaterThan(0);
    // Implicit preamble entries carry no section heading.
    expect(entries.every((e) => !e.section)).toBe(true);
  });

  test('captures intro prose before the first heading as a preamble entry', () => {
    const md = [
      'This project follows a strict layering rule.',
      '',
      '## Security',
      '- Validate all input.',
    ].join('\n');
    const entries = parseMarkdownRules(md, { origin: 'CLAUDE.md', idPrefix: 'claude' });
    const preamble = entries.find((e) => /strict layering rule/.test(e.content));
    const headed = entries.find((e) => /Validate all input/.test(e.title));
    expect(preamble).toBeDefined();
    expect(preamble!.section).toBeFalsy();
    expect(headed).toBeDefined();
    expect(headed!.type).toBe(KnowledgeType.Security);
  });

  test('does not emit a spurious preamble entry when the doc starts with a heading', () => {
    const md = ['## Coding Standards', '- Always use 2-space indentation.'].join('\n');
    const entries = parseMarkdownRules(md, { origin: 'x.md', idPrefix: 'x' });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.section).toBe('Coding Standards');
  });

  test('non-ASCII-only headings still yield valid, unique ids', () => {
    const md = [
      '## 安全性', // "Security" (CJK)
      '- 验证所有输入',
      '## Безопасность', // "Security" (Cyrillic)
      '- Проверяйте ввод',
    ].join('\n');
    const entries = parseMarkdownRules(md, { origin: 'CLAUDE.md', idPrefix: 'claude' });
    expect(entries.length).toBeGreaterThan(0);
    const idRe = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
    for (const e of entries) {
      expect(e.id).toMatch(idRe);
    }
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });
});
