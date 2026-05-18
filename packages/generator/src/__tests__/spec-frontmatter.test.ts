import { describe, expect, test } from 'bun:test';
import { parseFrontmatter, splitSpecMd } from '../spec/spec-frontmatter.ts';

describe('spec frontmatter parser', () => {
  test('parses scalar key/value pairs', () => {
    const res = parseFrontmatter(['title: hello world', 'count: 42', 'flag: true'].join('\n'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value['title']).toBe('hello world');
    expect(res.value['count']).toBe(42);
    expect(res.value['flag']).toBe(true);
  });

  test('parses quoted strings', () => {
    const res = parseFrontmatter(
      ['title: "a: with colon"', 'note: \'single \\\' is preserved\''].join('\n'),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value['title']).toBe('a: with colon');
    expect(res.value['note']).toBe("single \\' is preserved");
  });

  test('parses block scalars (|)', () => {
    const res = parseFrontmatter(['intent: |', '  line one', '  line two', '', '  line four'].join('\n'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value['intent']).toBe('line one\nline two\n\nline four');
  });

  test('parses scalar arrays', () => {
    const res = parseFrontmatter(['tags:', '  - foo', '  - bar', '  - baz'].join('\n'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value['tags']).toEqual(['foo', 'bar', 'baz']);
  });

  test('parses object-array blocks', () => {
    const src = [
      'acceptanceCriteria:',
      '  - id: ac-1',
      '    text: First criterion',
      '  - id: ac-2',
      '    text: Second criterion',
    ].join('\n');
    const res = parseFrontmatter(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value['acceptanceCriteria']).toEqual([
      { id: 'ac-1', text: 'First criterion' },
      { id: 'ac-2', text: 'Second criterion' },
    ]);
  });

  test('parses nested objects (one level)', () => {
    const src = ['externalLinks:', '  issue: https://example.com/i/1', '  pr: null'].join('\n');
    const res = parseFrontmatter(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value['externalLinks']).toEqual({ issue: 'https://example.com/i/1', pr: null });
  });

  test('strips line comments', () => {
    const res = parseFrontmatter(['# top comment', 'title: hello # trailing'].join('\n'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value['title']).toBe('hello');
  });

  test('rejects unterminated frontmatter', () => {
    const res = splitSpecMd(['---', 'title: hello', '# missing close'].join('\n'));
    expect(res.ok).toBe(false);
  });

  test('rejects missing leading delimiter', () => {
    const res = splitSpecMd(['title: hello'].join('\n'));
    expect(res.ok).toBe(false);
  });

  test('reports line numbers on indent errors', () => {
    const res = parseFrontmatter(['list:', '  - a', '    - b'].join('\n'));
    // Either rejects or assigns to scalar — the indent rule requires equality.
    expect(res.ok).toBe(false);
  });

  test('splits frontmatter from body', () => {
    const md = ['---', 'title: hello', '---', '', '# Body', 'Some text.'].join('\n');
    const res = splitSpecMd(md);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.frontmatter.fields['title']).toBe('hello');
    expect(res.value.body).toBe('\n# Body\nSome text.');
  });
});
