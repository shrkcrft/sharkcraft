/**
 * r78 — Cursor `.mdc` rules read through THE frontmatter parser (round 15
 * follow-up, F6).
 *
 * `parse-cursor-rule.ts` had its own line splitter (`/^([A-Za-z][\w-]*)\s*:/`
 * per line, brackets stripped and every comma split for `tags` / `globs`). It
 * now reads `splitFrontmatter` + `parseFrontmatter` in the `Text` scalar mode.
 * The expectations below were CAPTURED from the old parser on the same inputs
 * (a parity corpus of real `.mdc` shapes and each quirk), then:
 *
 *   PARITY — identical output: bare values verbatim (`description: 2024`,
 *     `1.50`, `null`, `Prefer #private fields`), comma-separated `globs`,
 *     wrapping quotes stripped, CRLF, no / empty frontmatter, `--- `, comment
 *     lines, the `shrk export cursor-rules` output.
 *   FIXED — a genuine bug in the old splitter, kept fixed (each says why):
 *     an empty `description:` became the title "" (and the id fell back to the
 *     prefix); a brace glob `*.{ts,tsx}` and a quoted comma were split apart; a
 *     block list of `globs:` was dropped; `\"` escapes were kept; a BOM hid the
 *     whole frontmatter; `description: |` became the title "|".
 *   LOUD — input outside THE grammar the old splitter read half-way without a
 *     word (a wrapped `description`, a nested inline list under `tags`, a
 *     `---x` "closing" line, no closing line at all): the key alone is ignored
 *     (or, for a broken block, the file is imported from its body), and
 *     `importCursorRules` prints a warning naming the line.
 *
 * Review fix: only the four keys the importer reads are parsed, each on its
 * own (`IParseFrontmatterOptions.keys`) — a key it never reads (`always
 * apply: true`, a wrapped `metadata:`) used to cost the whole frontmatter, and
 * `[Frontend] rules for [React]` read as a one-item list; both are PARITY now.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCursorRules, parseCursorRule, parseCursorRuleFile } from '../index.ts';

interface IExpected {
  readonly id: string;
  readonly title: string;
  readonly priority: string;
  readonly tags: readonly string[];
  readonly content: string;
}

function run(name: string, raw: string): { entry: IExpected; problems: readonly string[] } {
  const r = parseCursorRule(raw, { origin: `.cursor/rules/${name}.mdc`, idPrefix: `cursor.${name.toLowerCase()}` });
  const { id, title, priority, tags, content } = r.entry;
  return { entry: { id, title, priority, tags, content }, problems: r.problems };
}

const md = (...lines: string[]): string => lines.join('\n');

/** Old parser output, byte for byte — the migration must not move these. */
const PARITY: Readonly<Record<string, readonly [string, IExpected]>> = {
  standard: [
    md('---', 'description: Frontend rules', 'globs: src/**/*.tsx, src/**/*.ts', 'alwaysApply: false', '---', '', '# Frontend', '- Use hooks.'),
    { id: 'cursor.standard.frontend-rules', title: 'Frontend rules', priority: 'medium', tags: ['src-tsx', 'src-ts', 'frontend', 'rules'], content: '# Frontend\n- Use hooks.' },
  ],
  inlineArrayQuoted: [
    md('---', 'description: TS only', 'globs: ["**/*.ts", "**/*.tsx"]', '---', 'rule.'),
    { id: 'cursor.inlinearrayquoted.ts-only', title: 'TS only', priority: 'medium', tags: ['ts', 'tsx', 'only'], content: 'rule.' },
  ],
  tagsPriority: [
    md('---', 'description: Use bun test only', 'tags: [testing, bun]', 'priority: critical', '---', '', '- Do not introduce Jest.'),
    { id: 'cursor.tagspriority.use-bun-test-only', title: 'Use bun test only', priority: 'critical', tags: ['testing', 'bun', 'test', 'only'], content: '- Do not introduce Jest.' },
  ],
  crlf: [
    ['---', 'description: Use bun test only', 'tags: [testing, bun]', '---', '', '- Do not introduce Jest.'].join('\r\n'),
    { id: 'cursor.crlf.use-bun-test-only', title: 'Use bun test only', priority: 'medium', tags: ['testing', 'bun', 'test', 'only'], content: '- Do not introduce Jest.' },
  ],
  noFrontmatter: [
    '- Just a rule.',
    { id: 'cursor.nofrontmatter.just-a-rule', title: '- Just a rule.', priority: 'medium', tags: ['just', 'rule'], content: '- Just a rule.' },
  ],
  descriptionColon: [
    md('---', 'description: Rule: use bun', '---', 'b'),
    { id: 'cursor.descriptioncolon.rule-use-bun', title: 'Rule: use bun', priority: 'medium', tags: ['rule', 'bun'], content: 'b' },
  ],
  descriptionHash: [
    md('---', 'description: Prefer #private fields', '---', 'b'),
    { id: 'cursor.descriptionhash.prefer-private-fields', title: 'Prefer #private fields', priority: 'medium', tags: ['prefer', 'private', 'fields'], content: 'b' },
  ],
  descriptionSingleQuoted: [
    md('---', "description: 'Use bun'", '---', 'b'),
    { id: 'cursor.descriptionsinglequoted.use-bun', title: 'Use bun', priority: 'medium', tags: ['bun'], content: 'b' },
  ],
  commaQuoted: [
    md('---', 'description: CQ', 'globs: "*.ts", "*.tsx"', '---', 'b'),
    { id: 'cursor.commaquoted.cq', title: 'CQ', priority: 'medium', tags: ['ts', 'tsx'], content: 'b' },
  ],
  tagsBareComma: [
    md('---', 'description: TB', 'tags: testing, bun', '---', 'b'),
    { id: 'cursor.tagsbarecomma.tb', title: 'TB', priority: 'medium', tags: ['testing', 'bun'], content: 'b' },
  ],
  emptyFrontmatter: [
    md('---', '---', 'Body after empty'),
    { id: 'cursor.emptyfrontmatter.body-after-empty', title: 'Body after empty', priority: 'medium', tags: ['body', 'after', 'empty'], content: 'Body after empty' },
  ],
  delimiterTrailingSpace: [
    md('--- ', 'description: TS delim', '--- ', 'b'),
    { id: 'cursor.delimitertrailingspace.ts-delim', title: 'TS delim', priority: 'medium', tags: ['delim'], content: 'b' },
  ],
  alwaysApplyTrue: [
    md('---', 'description: AA', 'alwaysApply: True', '---', 'b'),
    { id: 'cursor.alwaysapplytrue.aa', title: 'AA', priority: 'medium', tags: [], content: 'b' },
  ],
  numericDescription: [
    md('---', 'description: 2024', 'priority: HIGH', '---', 'b'),
    { id: 'cursor.numericdescription.2024', title: '2024', priority: 'high', tags: ['2024'], content: 'b' },
  ],
  decimalDescription: [
    md('---', 'description: 1.50', '---', 'b'),
    { id: 'cursor.decimaldescription.1-50', title: '1.50', priority: 'medium', tags: [], content: 'b' },
  ],
  exportRoundTrip: [
    md('---', 'description: SharkCraft project rules (auto-generated)', 'alwaysApply: false', '---', '', '> preamble', '', '## Rules'),
    {
      id: 'cursor.exportroundtrip.sharkcraft-project-rules-auto-generated',
      title: 'SharkCraft project rules (auto-generated)',
      priority: 'medium',
      tags: ['sharkcraft', 'project', 'rules', 'auto'],
      content: '> preamble\n\n## Rules',
    },
  ],
  commentLine: [
    md('---', '# a comment', 'description: With comment line', '---', 'b'),
    { id: 'cursor.commentline.with-comment-line', title: 'With comment line', priority: 'medium', tags: ['comment', 'line'], content: 'b' },
  ],
  nullDescription: [
    md('---', 'description: null', '---', 'Body first'),
    { id: 'cursor.nulldescription.null', title: 'null', priority: 'medium', tags: ['null'], content: 'Body first' },
  ],
  leadingBlankLinesBody: [
    md('---', 'description: LB', '---', '', '', 'body'),
    { id: 'cursor.leadingblanklinesbody.lb', title: 'LB', priority: 'medium', tags: [], content: 'body' },
  ],
  // Review fix: a key the importer does not read is skipped unparsed — YAML the parser does not
  // speak there (a key with a space, a wrapped `metadata:`, an out-of-grammar map) cost the whole frontmatter.
  keyWithSpace: [
    md('---', 'description: KS', 'always apply: true', '---', 'b'),
    { id: 'cursor.keywithspace.ks', title: 'KS', priority: 'medium', tags: [], content: 'b' },
  ],
  unreadWrapped: [
    md('---', 'description: Unread wrap', 'globs: *.ts', 'metadata: some value', '  that wraps', '---', 'Body'),
    { id: 'cursor.unreadwrapped.unread-wrap', title: 'Unread wrap', priority: 'medium', tags: ['ts', 'unread', 'wrap'], content: 'Body' },
  ],
  unreadNestedBad: [
    md('---', 'description: Nested bad', 'extra:', '  - a: 1', '    b', '---', 'b'),
    { id: 'cursor.unreadnestedbad.nested-bad', title: 'Nested bad', priority: 'medium', tags: ['nested', 'bad'], content: 'b' },
  ],
  // Review fix: `[Frontend] rules for [React]` is text (its `[` closes before the end) — it read as a one-item list and was dropped.
  bracketDescription: [
    md('---', 'description: [Frontend] rules for [React]', 'globs: *.tsx', '---', 'Body'),
    { id: 'cursor.bracketdescription.frontend-rules-for-react', title: '[Frontend] rules for [React]', priority: 'medium', tags: ['tsx', 'frontend', 'rules', 'react'], content: 'Body' },
  ],
  // Round 15 closing (A1): only `globs` / `tags` are lists (`listKeys`) — `description` / `priority` read an
  // inline `[…]` verbatim, as the old splitter did (`description: [WIP]` was ignored as "a list" and the
  // title came from the body). Captured from HEAD's parser on the same input.
  wipDescription: [
    md('---', 'description: [WIP]', 'globs: *.ts', '---', 'Body line'),
    { id: 'cursor.wipdescription.wip', title: '[WIP]', priority: 'medium', tags: ['ts', 'wip'], content: 'Body line' },
  ],
  flowListDescription: [
    md('---', 'description: [Frontend, React]', 'priority: [high]', 'tags: [x, y]', '---', 'Body'),
    { id: 'cursor.flowlistdescription.frontend-react', title: '[Frontend, React]', priority: 'medium', tags: ['x', 'y', 'frontend', 'react'], content: 'Body' },
  ],
};

/** Old parser output was WRONG here; `was` records it, `now` is the kept fix. */
const FIXED: Readonly<Record<string, { readonly raw: string; readonly why: string; readonly was: Partial<IExpected>; readonly now: IExpected }>> = {
  emptyDescription: {
    raw: md('---', 'description:', 'globs: *.ts', 'alwaysApply: true', '---', '', '# Always typed', 'Body.'),
    why: 'an empty description is absent — the title falls back to the body (it was the empty string)',
    was: { id: 'cursor.emptydescription.cursor-emptydescription', title: '' },
    now: { id: 'cursor.emptydescription.always-typed', title: '# Always typed', priority: 'medium', tags: ['ts', 'typed'], content: '# Always typed\nBody.' },
  },
  emptyDescriptionSpaces: {
    raw: md('---', 'description: ', 'globs: ', 'alwaysApply: false', '---', '', 'First line of body', 'more'),
    why: 'same — `description: ` with only spaces',
    was: { id: 'cursor.emptydescriptionspaces.cursor-emptydescriptionspaces', title: '' },
    now: { id: 'cursor.emptydescriptionspaces.first-line-of-body', title: 'First line of body', priority: 'medium', tags: ['first', 'line', 'body'], content: 'First line of body\nmore' },
  },
  braceGlobBare: {
    raw: md('---', 'description: Brace', 'globs: src/**/*.{ts,tsx}, test/**', '---', 'b'),
    why: 'a brace glob is ONE glob — the comma inside {ts,tsx} is not a separator',
    was: { tags: ['src-ts', 'tsx', 'test', 'brace'] },
    now: { id: 'cursor.braceglobbare.brace', title: 'Brace', priority: 'medium', tags: ['src-ts-tsx', 'test', 'brace'], content: 'b' },
  },
  braceGlobQuotedArray: {
    raw: md('---', 'description: Brace q', 'globs: ["src/**/*.{ts,tsx}"]', '---', 'b'),
    why: 'a quoted list item is one item, whatever commas it holds',
    was: { tags: ['src-ts', 'tsx', 'brace'] },
    now: { id: 'cursor.braceglobquotedarray.brace-q', title: 'Brace q', priority: 'medium', tags: ['src-ts-tsx', 'brace'], content: 'b' },
  },
  tagsQuotedComma: {
    raw: md('---', 'description: TQ', 'tags: ["a, b", c]', '---', 'b'),
    why: 'same — the old splitter split on every comma, quotes or not',
    was: { tags: ['a', 'b', 'c'] },
    now: { id: 'cursor.tagsquotedcomma.tq', title: 'TQ', priority: 'medium', tags: ['a, b', 'c'], content: 'b' },
  },
  blockListGlobs: {
    raw: md('---', 'description: Block list', 'globs:', '  - "**/*.ts"', '  - src/**', '---', 'b'),
    why: 'a YAML block list was dropped (its `  - ` lines matched no key)',
    was: { tags: ['block', 'list'] },
    now: { id: 'cursor.blocklistglobs.block-list', title: 'Block list', priority: 'medium', tags: ['ts', 'src', 'block', 'list'], content: 'b' },
  },
  descriptionEscapes: {
    raw: md('---', 'description: "Use \\"bun\\" only"', '---', 'b'),
    why: 'a double-quoted value\'s escapes are undone (the backslashes were kept)',
    was: { title: 'Use \\"bun\\" only' },
    now: { id: 'cursor.descriptionescapes.use-bun-only', title: 'Use "bun" only', priority: 'medium', tags: ['bun', 'only'], content: 'b' },
  },
  bom: {
    raw: '\uFEFF' + md('---', 'description: BOM rule', '---', 'b'),
    why: 'a BOM (Windows editors) hid the whole frontmatter — the title was "\\uFEFF---"',
    was: { id: 'cursor.bom.cursor-bom', title: '\uFEFF---' },
    now: { id: 'cursor.bom.bom-rule', title: 'BOM rule', priority: 'medium', tags: ['bom', 'rule'], content: 'b' },
  },
  blockScalarDescription: {
    raw: md('---', 'description: |', '  multi', '  line', '---', 'b'),
    why: 'a block scalar is its text (the title was "|")',
    was: { title: '|' },
    now: { id: 'cursor.blockscalardescription.multi-line', title: 'multi\nline', priority: 'medium', tags: ['multi', 'line'], content: 'b' },
  },
};

/** Outside THE grammar: imported from the body, with a warning — the old splitter read these half-way silently. */
const LOUD: Readonly<Record<string, { readonly raw: string; readonly was: Partial<IExpected>; readonly now: IExpected; readonly problem: string }>> = {
  multilineDescription: {
    raw: md('---', 'description: This is a long', '  description continued', 'globs: *.ts', '---', 'Body line'),
    was: { title: 'This is a long' },
    // Review fix: each read key is parsed on its own — the wrapped description costs that key alone and
    // `globs` still reads (it cost the whole frontmatter: tags were ['body', 'line']).
    now: { id: 'cursor.multilinedescription.body-line', title: 'Body line', priority: 'medium', tags: ['ts', 'body', 'line'], content: 'Body line' },
    problem: 'description: not read (Top-level key must start at column 0 (line 3))',
  },
  tagsNested: {
    raw: md('---', 'description: TN', 'tags: [a, [b]]', '---', 'b'),
    was: { tags: ['a', '[b]'] },
    now: { id: 'cursor.tagsnested.tn', title: 'TN', priority: 'medium', tags: [], content: 'b' },
    problem: 'tags: not read (Nested inline arrays are not supported (line 3))',
  },
  closingWithSuffix: {
    raw: md('---', 'description: suffix close', '---x', 'body'),
    was: { title: 'suffix close', content: 'x\nbody' },
    now: { id: 'cursor.closingwithsuffix.cursor-closingwithsuffix', title: '---', priority: 'medium', tags: [], content: '---\ndescription: suffix close\n---x\nbody' },
    problem: 'frontmatter: an opening --- line has no closing --- line',
  },
  unterminated: {
    raw: md('---', 'description: never closed', 'body'),
    was: { title: '---', content: '---\ndescription: never closed\nbody' },
    now: { id: 'cursor.unterminated.cursor-unterminated', title: '---', priority: 'medium', tags: [], content: '---\ndescription: never closed\nbody' },
    problem: 'frontmatter: an opening --- line has no closing --- line',
  },
};

describe('r78 parseCursorRule — parity with the old splitter on real .mdc shapes', () => {
  for (const [name, [raw, want]] of Object.entries(PARITY)) {
    test(name, () => {
      expect(run(name, raw)).toEqual({ entry: want, problems: [] });
      // The entry-only API is the same reading.
      const e = parseCursorRuleFile(raw, { origin: `.cursor/rules/${name}.mdc`, idPrefix: `cursor.${name.toLowerCase()}` });
      expect(e.id).toBe(want.id);
    });
  }
});

describe('r78 parseCursorRule — the old splitter\'s bugs stay fixed', () => {
  for (const [name, c] of Object.entries(FIXED)) {
    test(`${name}: ${c.why}`, () => {
      const r = run(name, c.raw);
      expect(r).toEqual({ entry: c.now, problems: [] });
      for (const [k, v] of Object.entries(c.was)) expect(r.entry[k as keyof IExpected]).not.toEqual(v);
    });
  }
});

describe('r78 parseCursorRule — out-of-grammar frontmatter is loud, never half-read', () => {
  for (const [name, c] of Object.entries(LOUD)) {
    test(name, () => {
      const r = run(name, c.raw);
      expect(r.entry).toEqual(c.now);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toContain(c.problem);
      for (const [k, v] of Object.entries(c.was)) {
        if (k === 'title' && v === c.now.title) continue;
        if (k === 'content' && v === c.now.content) continue;
        expect(r.entry[k as keyof IExpected]).not.toEqual(v);
      }
    });
  }

  test('a field of the wrong shape is ignored by name, the rest still read', () => {
    const r = run('shape', md('---', 'description:', '  - a', '  - b', 'priority: high', 'globs:', '  - kind: file', '---', 'Body'));
    expect(r.entry.title).toBe('Body');
    expect(r.entry.priority).toBe('high');
    expect(r.problems).toEqual([
      'description: must be a single value (got a list) — ignored',
      'globs: must be a list of plain values or a comma-separated string (got a list of maps) — ignored',
    ]);
  });
});

describe('r78 importCursorRules — every frontmatter problem is a warning naming the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'shrk-r78-cursor-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('a real .cursor/rules tree: clean files warn nothing, a broken one names its line', () => {
    const rules = join(root, '.cursor', 'rules');
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(rules, 'frontend.mdc'), PARITY['standard']![0]);
    writeFileSync(join(rules, 'wrapped.mdc'), LOUD['multilineDescription']!.raw);
    writeFileSync(join(rules, 'bom.mdc'), FIXED['bom']!.raw);
    const r = importCursorRules({ filePath: '.cursor/rules', projectRoot: root });
    expect(r.entries.map((e) => [e.origin, e.title])).toEqual([
      ['.cursor/rules/bom.mdc', 'BOM rule'],
      ['.cursor/rules/frontend.mdc', 'Frontend rules'],
      ['.cursor/rules/wrapped.mdc', 'Body line'],
    ]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.origin).toBe('.cursor/rules/wrapped.mdc');
    expect(r.warnings[0]!.message).toContain('line 3');
    expect(r.warnings[0]!.message).toContain('the title comes from the body');
  });
});
