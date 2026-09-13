/**
 * r78 — decision records read through THE frontmatter parser (round 15
 * follow-up, F6).
 *
 * `decision-records.ts` split frontmatter with `/^---\n([\s\S]*?)\n---/` and
 * `line.indexOf(':')` per line. It now reads `splitFrontmatter` +
 * `parseFrontmatter` in the `Text` scalar mode. The expectations were
 * CAPTURED from the old splitter on the same files (every record in this repo,
 * the r18 example, MADR shapes and each quirk), then:
 *
 *   PARITY — identical: values verbatim (`id: 0001`, `title: Fix #12`,
 *     `status: accepted # note`, `title: null`), MADR `{…}` placeholders, no /
 *     empty frontmatter, the body sections, `docs/adr/`, every repo record.
 *   FIXED — a genuine bug, kept fixed: an indented `  id:` overwrote the
 *     record's id (the round-15 knowledge bug); a CRLF, BOM or `--- ` file
 *     lost its frontmatter; `'x'` kept its quotes, `"\"x\""` its backslashes,
 *     `"a" and "b"` lost its outer quotes; `id:` / `title:` / `status:` with no
 *     value read as "".
 *   REJECTED — out of THE grammar in the top-level structure or under a key
 *     the record reads (a stray line naming no key, a `title:` wrapped onto an
 *     indented line, a `---` that never closes, a BLOCK list under `title:`;
 *     round 15 closing A1: an inline `title: [WIP]` is text — PARITY): the old
 *     splitter skipped the line and listed a half-read record. (Review fix: a
 *     key the record never reads — `related rules:`, a wrapped `summary:`, a
 *     two-level map — is skipped unparsed, so those are PARITY now, and
 *     `[RFC] Adopt [Bun]` is text.) The record is now refused through the round-12
 *     channel — `loadTsDecisionsWithIssues` `rejected`, the registry outcomes,
 *     the contribution rejections, `decision-invalid` in the self-config doctor
 *     — and never listed or resolvable.
 *
 * Plus the writer: `previewDecisionDraft` output reads back as written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  buildSelfConfigDoctorReportV2,
  collectContributionRejections,
  collectRegistryOutcomes,
  inspectSharkcraft,
  listDecisions,
  loadTsDecisionsWithIssues,
  previewDecisionDraft,
  referenceIdsFor,
  type IDecisionRecord,
} from '../index.ts';
import { ContributionKind } from '../contribution-kind.ts';

// packages/inspector/src/__tests__ → repo root is four levels up.
const REPO_DECISIONS = resolve(import.meta.dir, '../../../../sharkcraft/decisions');

type Inspection = Awaited<ReturnType<typeof inspectSharkcraft>>;

const md = (...lines: string[]): string => lines.join('\n');

/** file → contents; each lands in sharkcraft/decisions/ (or the path given). */
const PARITY: Readonly<Record<string, { readonly raw: string; readonly want: Partial<IDecisionRecord> }>> = {
  'r18-example.md': {
    raw: md('---', 'id: 0001-example', 'title: Example', 'status: accepted', 'date: 2026-01-01', '---', '', '## Context', 'Why.', '', '## Decision', 'Do it.', '', '## Consequences', 'OK.', ''),
    want: { id: '0001-example', title: 'Example', status: 'accepted' as IDecisionRecord['status'], date: '2026-01-01', context: 'Why.', decision: 'Do it.', consequences: 'OK.' },
  },
  'numeric-id.md': {
    raw: md('---', 'id: 0001', 'title: Numeric id', 'status: accepted', 'date: 2026-01-01', '---', '', '## Context', 'C.', ''),
    want: { id: '0001', title: 'Numeric id', date: '2026-01-01', context: 'C.' },
  },
  'hash-title.md': {
    raw: md('---', 'id: hash-title', 'title: Fix #12 regression', 'status: accepted # was proposed', '---', ''),
    want: { id: 'hash-title', title: 'Fix #12 regression', status: 'accepted # was proposed' as IDecisionRecord['status'] },
  },
  'null-title.md': {
    raw: md('---', 'id: null-title', 'title: null', 'status: ~', '---', ''),
    want: { id: 'null-title', title: 'null', status: '~' as IDecisionRecord['status'] },
  },
  'madr-no-frontmatter.md': {
    raw: md('# Use Markdown ADRs', '', '* Status: accepted', '', '## Context', 'We need records.', '', '## Decision', 'MADR.', ''),
    want: { id: 'madr-no-frontmatter', title: 'madr-no-frontmatter', status: 'proposed' as IDecisionRecord['status'], context: 'We need records.', decision: 'MADR.' },
  },
  'madr-v4.md': {
    raw: md(
      '---',
      '# These are optional metadata elements. Feel free to remove any of them.',
      'status: "{proposed | rejected | accepted | deprecated | superseded by ADR-0123}"',
      'date: {YYYY-MM-DD when the decision was last updated}',
      'decision-makers: {list everyone involved in the decision}',
      'consulted: {list everyone whose opinions are sought}',
      '---',
      '',
      '# Title',
      '',
      '## Context',
      'x',
    ),
    want: {
      id: 'madr-v4',
      status: '{proposed | rejected | accepted | deprecated | superseded by ADR-0123}' as IDecisionRecord['status'],
      date: '{YYYY-MM-DD when the decision was last updated}',
      context: 'x',
    },
  },
  'empty-frontmatter.md': {
    raw: md('---', '---', '## Context', 'Empty fm.', ''),
    want: { id: 'empty-frontmatter', title: 'empty-frontmatter', context: 'Empty fm.' },
  },
  'related-sections.md': {
    raw: md('---', 'id: related-sections', 'title: Related', 'status: accepted', '---', '', '## Related rules', '- rule.a', '- rule.b', '', '## Related files', '* src/a.ts', ''),
    want: { id: 'related-sections', relatedRules: ['rule.a', 'rule.b'], relatedFiles: ['src/a.ts'] },
  },
  // Review fix: a key the record does not read is skipped unparsed — valid YAML the parser does not
  // speak there (a key with a space, a wrapped plain scalar, a two-level map) REJECTED the record.
  'key-with-space.md': {
    raw: md('---', 'id: key-space', 'related rules: x', '---', ''),
    want: { id: 'key-space', title: 'key-space' },
  },
  'unread-wrapped.md': {
    raw: md('---', 'id: unread-wrapped', 'title: Use Kafka', 'status: accepted', 'summary: We will use Kafka', '  for messaging.', '---', '', '## Context', 'Queues.', ''),
    want: { id: 'unread-wrapped', title: 'Use Kafka', status: 'accepted' as IDecisionRecord['status'], context: 'Queues.' },
  },
  'unread-nested.md': {
    raw: md('---', 'id: unread-nested', 'title: Nested meta', 'meta:', '  a:', '    b: c', 'decision-makers:', '- Alice', '- Bob', '---', ''),
    want: { id: 'unread-nested', title: 'Nested meta' },
  },
  // Review fix: `[RFC] Adopt [Bun]` is text (its `[` closes before the end) — it read as a one-item list.
  'bracket-title.md': {
    raw: md('---', 'id: bracket-title', 'title: [RFC] Adopt [Bun]', '---', ''),
    want: { id: 'bracket-title', title: '[RFC] Adopt [Bun]' },
  },
  // Round 15 closing (A1): no key a record reads is a list (`listKeys: []`), so an inline `[…]` is the
  // value verbatim, as the old splitter read it — `title: [WIP]` REJECTED the record as "a list".
  'list-title.md': {
    raw: md('---', 'id: list-title', 'title: [WIP]', '---', ''),
    want: { id: 'list-title', title: '[WIP]' },
  },
  'flow-list-values.md': {
    raw: md('---', 'id: [flow-id]', 'title: [a, b]', 'status: [accepted]', 'date: [2026-01-01]', '---', ''),
    want: { id: '[flow-id]', title: '[a, b]', status: '[accepted]' as IDecisionRecord['status'], date: '[2026-01-01]' },
  },
};

/** Old output was WRONG; `was` records it, `want` is the kept fix. */
const FIXED: Readonly<Record<string, { readonly raw: string; readonly why: string; readonly was: Partial<IDecisionRecord>; readonly want: Partial<IDecisionRecord> }>> = {
  'nested-id-overwrite.md': {
    raw: md('---', 'id: nested-top', 'title: Top', 'related:', '  id: nested-inner', '  title: Inner', '---', ''),
    why: 'an indented line belongs to its block — it never sets the record\'s own id / title',
    was: { id: 'nested-inner', title: 'Inner' },
    want: { id: 'nested-top', title: 'Top' },
  },
  'crlf.md': {
    raw: ['---', 'id: crlf-record', 'title: CRLF record', 'status: accepted', '---', '', '## Context', 'Windows.'].join('\r\n'),
    why: 'a CRLF file had its whole frontmatter ignored',
    was: { id: 'crlf', status: 'proposed' as IDecisionRecord['status'] },
    want: { id: 'crlf-record', title: 'CRLF record', status: 'accepted' as IDecisionRecord['status'], context: 'Windows.' },
  },
  'bom.md': {
    raw: '\uFEFF' + md('---', 'id: bom-record', 'title: BOM record', '---', ''),
    why: 'a BOM hid the frontmatter',
    was: { id: 'bom', title: 'bom' },
    want: { id: 'bom-record', title: 'BOM record' },
  },
  'trailing-space-delimiter.md': {
    raw: md('--- ', 'id: trailing-delim', 'title: Trailing delim', '--- ', '## Context', 'T.', ''),
    why: '`--- ` (trailing whitespace) is a delimiter',
    was: { id: 'trailing-space-delimiter' },
    want: { id: 'trailing-delim', title: 'Trailing delim', context: 'T.' },
  },
  'empty-values.md': {
    raw: md('---', 'id: empty-values', 'title:', 'status:', 'date:', '---', ''),
    why: 'a key with no value is absent — the documented defaults apply (they read as "")',
    was: { title: '', status: '' as IDecisionRecord['status'] },
    want: { id: 'empty-values', title: 'empty-values', status: 'proposed' as IDecisionRecord['status'], date: '' },
  },
  'empty-id.md': {
    raw: md('---', 'id:', 'title: Empty id', '---', ''),
    why: 'an empty id falls back to the file name (it was the id "")',
    was: { id: '' },
    want: { id: 'empty-id', title: 'Empty id' },
  },
  'single-quoted-title.md': {
    raw: md('---', 'id: sq-title', "title: 'Single quoted'", '---', ''),
    why: 'a single-quoted value is unquoted',
    was: { title: "'Single quoted'" },
    want: { id: 'sq-title', title: 'Single quoted' },
  },
  'escaped-title.md': {
    raw: md('---', 'id: esc-title', 'title: "Use \\"bun\\" only"', '---', ''),
    why: 'a double-quoted value\'s escapes are undone',
    was: { title: 'Use \\"bun\\" only' },
    want: { id: 'esc-title', title: 'Use "bun" only' },
  },
  'inner-quotes-title.md': {
    raw: md('---', 'id: inner-quotes', 'title: "a" and "b"', '---', ''),
    why: 'a value that only starts and ends with a quote is text (its outer quotes were cut)',
    was: { title: 'a" and "b' },
    want: { id: 'inner-quotes', title: '"a" and "b"' },
  },
};

const UNTERMINATED = 'frontmatter: an opening --- line has no closing --- line';

/** Out of THE grammar: REJECTED, every reason named (the old splitter listed a half-read record). */
const REJECTED: Readonly<Record<string, { readonly raw: string; readonly entryId: string | null; readonly reasons: readonly string[] }>> = {
  'line-without-colon.md': {
    raw: md('---', 'id: no-colon', 'title: No colon', 'just some text', '---', ''),
    entryId: null,
    reasons: ['frontmatter: Expected "<key>:" at line 4'],
  },
  // A key the record READS, wrapped onto an indented line (out of THE grammar) — the old splitter read "A long".
  'read-key-wrapped.md': {
    raw: md('---', 'id: read-key-wrapped', 'title: A long', '  wrapped title', '---', ''),
    entryId: null,
    reasons: ['frontmatter: Top-level key must start at column 0 (line 4)'],
  },
  // A BLOCK list under a key the record reads as one value is structure, not text — still refused by name
  // (an inline `title: [WIP]` is text now: PARITY above, round 15 closing A1).
  'block-list-title.md': {
    raw: md('---', 'id: block-list-title', 'title:', '  - a', '  - b', '---', ''),
    entryId: 'block-list-title',
    reasons: ['title: must be a single value (got a list) — quote it if it is text'],
  },
  'unterminated.md': {
    raw: md('---', 'id: unterminated', 'title: Unterminated', '', '## Context', 'C.', ''),
    entryId: null,
    reasons: [UNTERMINATED],
  },
  'closing-with-suffix.md': {
    raw: md('---', 'id: close-suffix', 'title: Close suffix', '---x', '## Context', 'C.', ''),
    entryId: null,
    reasons: [UNTERMINATED],
  },
};

const DRAFT_TITLES: readonly string[] = [
  'Plain title',
  'Fix #12 regression',
  '0012',
  '"Quoted"',
  '[WIP]',
  'Title: with colon',
  'true',
  "It's fine",
  'null',
  '~',
  '- dash start',
  'a # b',
  'Trailing colon:',
];

let root = '';
let inspection: Inspection;
const repoFiles = readdirSync(REPO_DECISIONS).filter((f) => f.endsWith('.md')).sort();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'shrk-r78-decisions-'));
  const dir = join(root, 'sharkcraft', 'decisions');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r78-decisions', version: '0.0.0', private: true }));
  for (const table of [PARITY, FIXED, REJECTED]) {
    for (const [file, c] of Object.entries(table)) writeFileSync(join(dir, file), c.raw);
  }
  writeFileSync(join(root, 'docs', 'adr', '0002-adr-dir.md'), md('---', 'id: adr-dir', 'title: From docs/adr', '---', ''));
  for (const f of repoFiles) copyFileSync(join(REPO_DECISIONS, f), join(dir, `repo-${f}`));
  DRAFT_TITLES.forEach((title, i) => {
    writeFileSync(join(dir, `draft-${i}.md`), previewDecisionDraft({ id: `draft-${i}`, title, date: '2026-01-01', context: 'Ctx.' }));
  });
  inspection = await inspectSharkcraft({ cwd: root });
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function byFile(): ReadonlyMap<string, IDecisionRecord> {
  return new Map(listDecisions(inspection).map((d) => [basename(d.sourceFile ?? ''), d]));
}

describe('r78 decision records — parity with the old splitter', () => {
  test('values verbatim, MADR shapes, no / empty frontmatter, body sections', () => {
    const got = byFile();
    for (const [file, c] of Object.entries(PARITY)) {
      const d = got.get(file);
      const picked = d ? Object.fromEntries(Object.keys(c.want).map((k) => [k, d[k as keyof IDecisionRecord]])) : undefined;
      expect({ file, picked }).toEqual({ file, picked: c.want });
    }
  });

  test('docs/adr/ is read the same way', () => {
    expect(byFile().get('0002-adr-dir.md')?.id).toBe('adr-dir');
  });

  test('every decision record in this repo reads as before, and none is rejected', async () => {
    const got = byFile();
    expect(repoFiles.length).toBeGreaterThan(0);
    for (const f of repoFiles) {
      const d = got.get(`repo-${f}`);
      expect({ f, id: d?.id, titled: (d?.title ?? '').length > 0, status: d?.status, date: d?.date, context: (d?.context ?? '').length > 0 }).toEqual({
        f,
        id: f.replace(/\.md$/, ''),
        titled: true,
        status: 'accepted' as IDecisionRecord['status'],
        date: '2026-05-15',
        context: true,
      });
    }
    const rejectedRepo = (await loadTsDecisionsWithIssues(inspection)).rejected.filter((r) => basename(r.file).startsWith('repo-'));
    expect(rejectedRepo).toEqual([]);
  });
});

describe('r78 decision records — the old splitter\'s bugs stay fixed', () => {
  for (const [file, c] of Object.entries(FIXED)) {
    test(`${file}: ${c.why}`, () => {
      const d = byFile().get(file);
      expect(d).toBeDefined();
      for (const [k, v] of Object.entries(c.want)) expect({ k, v: d![k as keyof IDecisionRecord] }).toEqual({ k, v });
      for (const [k, v] of Object.entries(c.was)) expect(d![k as keyof IDecisionRecord]).not.toEqual(v);
    });
  }
});

describe('r78 decision records — unreadable frontmatter is REJECTED on every surface, never half-read', () => {
  const rejectedFiles = Object.keys(REJECTED).sort();

  test('not listed, and not resolvable as a decision id', () => {
    const listed = [...byFile().keys()];
    expect(listed.filter((f) => f in REJECTED)).toEqual([]);
    const ids = referenceIdsFor(inspection, 'decision');
    expect(ids).toContain('nested-top');
    expect(ids).toContain('0001');
    // Review fix: valid YAML under a key the record never reads no longer costs its id.
    for (const kept of ['key-space', 'unread-wrapped', 'unread-nested', 'bracket-title']) expect(ids).toContain(kept);
    // Round 15 closing (A1): an inline `title: [WIP]` is text, so the record — and its id — is kept.
    for (const kept of ['list-title', '[flow-id]']) expect(ids).toContain(kept);
    for (const gone of ['block-list-title', 'no-colon', 'read-key-wrapped', 'unterminated', 'close-suffix']) expect(ids).not.toContain(gone);
  });

  test('loadTsDecisionsWithIssues carries each with every reason (accepted + rejected = declared, per file)', async () => {
    const r = await loadTsDecisionsWithIssues(inspection);
    const md = r.rejected.filter((x) => x.file.includes(`${join('sharkcraft', 'decisions')}`));
    expect(md.map((x) => basename(x.file)).sort()).toEqual(rejectedFiles);
    for (const x of md) {
      const want = REJECTED[basename(x.file)]!;
      expect({ file: basename(x.file), index: x.index, entryId: x.entryId ?? null, reasons: x.reasons, cause: x.cause }).toEqual({
        file: basename(x.file),
        index: -1,
        entryId: want.entryId,
        reasons: [...want.reasons],
        cause: 'invalid' as typeof x.cause,
      });
    }
    // Every Markdown file is either listed or rejected — never neither.
    const listed = new Set(byFile().keys());
    for (const f of readdirSync(join(root, 'sharkcraft', 'decisions'))) {
      expect({ f, accounted: listed.has(f) !== rejectedFiles.includes(f) }).toEqual({ f, accounted: true });
    }
  });

  test('the registry outcomes and THE contribution-rejection channel carry them as decision rejections', async () => {
    const outcomes = await collectRegistryOutcomes(inspection, { kinds: [ContributionKind.Decision] });
    const fromOutcomes = outcomes.rejections.filter((x) => x.kind === ContributionKind.Decision).map((x) => basename(x.file)).sort();
    expect(fromOutcomes).toEqual(rejectedFiles);
    const channel = collectContributionRejections(inspection, outcomes.rejections)
      .filter((x) => x.kind === ContributionKind.Decision)
      .map((x) => basename(x.file))
      .sort();
    expect(channel).toEqual(rejectedFiles);
  });

  test('the self-config doctor reports each as a decision-invalid ERROR', async () => {
    const report = await buildSelfConfigDoctorReportV2(inspection);
    for (const file of rejectedFiles) {
      const hits = report.findings.filter((f) => f.code === 'decision-invalid' && (f.file ?? '').endsWith(`/${file}`));
      expect({ file, found: hits.length > 0, errors: hits.every((f) => f.severity === 'error') }).toEqual({ file, found: true, errors: true });
    }
  }, 60_000);
});

describe('r78 previewDecisionDraft — what the writer writes, THE parser reads back', () => {
  test('every draft title round-trips', () => {
    const got = byFile();
    DRAFT_TITLES.forEach((title, i) => {
      expect({ i, title: got.get(`draft-${i}.md`)?.title }).toEqual({ i, title });
    });
  });

  test('a value that already reads back stays bare; one that would not is quoted', () => {
    const plain = previewDecisionDraft({ id: '0002-test', title: 'Test', date: '2026-01-01' });
    expect(plain).toContain('\nid: 0002-test\n');
    expect(plain).toContain('\ntitle: Test\n');
    expect(plain).toContain('\nstatus: proposed\n');
    const wip = previewDecisionDraft({ id: 'x', title: '[WIP]', date: '2026-01-01' });
    expect(wip).toContain('\ntitle: "[WIP]"\n');
  });
});
