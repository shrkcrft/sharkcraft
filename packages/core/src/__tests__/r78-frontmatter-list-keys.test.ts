/**
 * r78 — `IParseFrontmatterOptions.listKeys` (round 15 closing, A1).
 *
 * The F6 migration moved decision records and Cursor `.mdc` rules onto THE
 * parser, whose YAML reading turns any inline `[…]` into a flow list. Their old
 * line splitters read a string field verbatim, so `title: [WIP]` (a decision)
 * became a REJECTED record and `description: [WIP]` (an `.mdc` rule) an ignored
 * one. A reader now names the keys it reads as LISTS; an inline `[…]` under any
 * other top-level key is that key's one value. A parser option — never a
 * second parser.
 */
import { describe, expect, test } from 'bun:test';
import { FrontmatterScalarMode, parseFrontmatter, type IParseFrontmatterOptions } from '../index.ts';

const TEXT = FrontmatterScalarMode.Text;

function read(raw: string, options: IParseFrontmatterOptions): Readonly<Record<string, unknown>> {
  const r = parseFrontmatter(raw, options);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('r78 listKeys — only a key read as a list parses an inline [...] as one', () => {
  const RAW = ['title: [WIP]', 'status: [a, b]', 'globs: [*.ts, "a, b"]', 'tags: [x]'].join('\n');

  test('a one-value key keeps a flow-list-looking value verbatim; a list key still reads a list', () => {
    expect(read(RAW, { scalars: TEXT, listKeys: ['globs', 'tags'] })).toEqual({
      title: '[WIP]',
      status: '[a, b]',
      globs: ['*.ts', 'a, b'],
      tags: ['x'],
    });
  });

  test('omitted: every inline [...] is a flow list (YAML — the Markdown knowledge and spec reading, unchanged)', () => {
    expect(read(RAW, { scalars: TEXT })).toEqual({ title: ['WIP'], status: ['a', 'b'], globs: ['*.ts', 'a, b'], tags: ['x'] });
    expect(read('title: [WIP]', {})).toEqual({ title: ['WIP'] });
  });

  test('listKeys: [] reads no inline [...] as a list — `[RFC] Adopt [Bun]` and `[a, b]` alike', () => {
    expect(read(['id: [x]', 'title: [RFC] Adopt [Bun]', 'date: [2026-01-01]'].join('\n'), { scalars: TEXT, listKeys: [] })).toEqual({
      id: '[x]',
      title: '[RFC] Adopt [Bun]',
      date: '[2026-01-01]',
    });
  });

  test('a wholly quoted value is still unquoted; the Typed reading honours listKeys too', () => {
    expect(read('title: "[WIP]"', { scalars: TEXT, listKeys: [] })).toEqual({ title: '[WIP]' });
    expect(read(['title: [WIP] # draft', 'n: [1, 2]'].join('\n'), { listKeys: ['n'] })).toEqual({ title: '[WIP]', n: [1, 2] });
  });

  test('a block list is structure — it stays a list under any key (the reader refuses its shape by name)', () => {
    expect(read(['title:', '  - a', '  - b'].join('\n'), { scalars: TEXT, listKeys: [] })).toEqual({ title: ['a', 'b'] });
  });

  test('nested values are unaffected — listKeys names top-level keys', () => {
    expect(read(['meta:', '  tags: [a, b]'].join('\n'), { scalars: TEXT, listKeys: [] })).toEqual({ meta: { tags: ['a', 'b'] } });
  });

  test('composes with keys: an unread key is still skipped unparsed, a read one-value key stays text', () => {
    expect(
      read(['title: [WIP]', 'decision makers: [', 'id: x'].join('\n'), { scalars: TEXT, keys: ['id', 'title'], listKeys: [] }),
    ).toEqual({ id: 'x', title: '[WIP]' });
  });
});
