/**
 * r78 — THE frontmatter parser, moved down to @shrkcrft/core (round 15, 15.2).
 *
 * The Markdown knowledge loader used a line splitter that trimmed every key and
 * ignored indentation, so `  id: x` under ANY block overwrote the entry's id
 * (and `  title:` / `  type:` / `  priority:` its other fields). It now reads
 * frontmatter through the generator's indentation-aware, Result-returning
 * parser — one authority for spec.md and Markdown knowledge. These lock the
 * behaviours the loader relies on, including the quirks it normalises.
 */
import { describe, expect, test } from 'bun:test';
import { parseFrontmatter } from '../index.ts';

function fields(raw: string): Readonly<Record<string, unknown>> {
  const r = parseFrontmatter(raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('r78 parseFrontmatter — an indented line never sets a top-level field', () => {
  test('a nested id / title / type / priority stays inside its block', () => {
    const v = fields(
      [
        'id: doc.guide',
        'title: Guide',
        'metadata:',
        '  title: Overridden title',
        '  type: rule',
        '  priority: critical',
        'references:',
        '  - kind: template',
        '    id: app.service',
      ].join('\n'),
    );
    expect(v['id']).toBe('doc.guide');
    expect(v['title']).toBe('Guide');
    expect(v['type']).toBeUndefined();
    expect(v['priority']).toBeUndefined();
    expect(v['metadata']).toEqual({ title: 'Overridden title', type: 'rule', priority: 'critical' });
    expect(v['references']).toEqual([{ kind: 'template', id: 'app.service' }]);
  });
});

describe('r78 parseFrontmatter — the shapes a references: list takes', () => {
  test('a list of maps with scalar fields', () => {
    const v = fields(
      ['references:', '  - kind: file', '    path: src/a.ts', '  - kind: symbol', '    symbol: helper', '    required: true'].join('\n'),
    );
    expect(v['references']).toEqual([
      { kind: 'file', path: 'src/a.ts' },
      { kind: 'symbol', symbol: 'helper', required: true },
    ]);
  });

  test('an inline list of strings (quoted or not)', () => {
    expect(fields('references: [file:src/a.ts, "symbol:Foo@src/foo.ts"]')['references']).toEqual([
      'file:src/a.ts',
      'symbol:Foo@src/foo.ts',
    ]);
  });

  test('the quirk the loader normalises: an unquoted `- kind:value` block item is a single-key map', () => {
    expect(fields(['references:', '  - file:src/a.ts', '  - url:https://example.com/x'].join('\n'))['references']).toEqual([
      { file: 'src/a.ts' },
      { url: 'https://example.com/x' },
    ]);
  });

  test('a quoted block item is a string', () => {
    expect(fields(['references:', '  - "file:src/a.ts"'].join('\n'))['references']).toEqual(['file:src/a.ts']);
  });

  test('a list at the key\'s own column (YAML\'s compact sequence) is a list', () => {
    expect(fields(['tags:', '- a', '- b', 'title: x'].join('\n'))).toEqual({ tags: ['a', 'b'], title: 'x' });
  });

  test('a mixed string / map list is refused, and the error says why', () => {
    const r = parseFrontmatter(['references:', '  - "file:src/a.ts"', '  - kind: file', '    path: src/b.ts'].join('\n'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('Mixed array kinds at line 3');
    expect(r.error.message).toContain('not both');
  });

  test('a non-list value is returned as-is — the caller type-checks it', () => {
    expect(fields('references: src/a.ts')['references']).toBe('src/a.ts');
    expect(fields(['references:', '  kind: file', '  path: src/a.ts'].join('\n'))['references']).toEqual({
      kind: 'file',
      path: 'src/a.ts',
    });
  });
});

describe('r78 parseFrontmatter — line numbers and block scalars', () => {
  test('lineOffset makes an error name the FILE line', () => {
    const raw = ['references:', '  - kind: file', '    count:', '      source:', '        files: [a]'].join('\n');
    const plain = parseFrontmatter(raw);
    const offset = parseFrontmatter(raw, { lineOffset: 1 });
    expect(plain.ok || offset.ok).toBe(false);
    if (plain.ok || offset.ok) return;
    const n = Number(/line (\d+)/.exec(plain.error.message)?.[1]);
    expect(offset.error.message).toContain(`line ${n + 1}`);
  });

  test('`>` folds lines with a space; `|` keeps them', () => {
    const v = fields(['summary: >', '  one', '  two', '', '  three', 'body: |', '  a', '  b'].join('\n'));
    expect(v['summary']).toBe('one two\nthree');
    expect(v['body']).toBe('a\nb');
  });
});
