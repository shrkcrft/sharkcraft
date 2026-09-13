/**
 * r78 — ONE frontmatter parser (round 15 follow-up, F6). THE TWO-WAY LOCK.
 *
 * Round 15 moved the spec parser down to `@shrkcrft/core` (`parseFrontmatter`)
 * and made the Markdown knowledge loader read through it; the follow-up moved
 * the last two ad-hoc line splitters onto it — decision records
 * (`packages/inspector/src/decision-records.ts`) and Cursor `.mdc` rules
 * (`packages/importer/src/parse/parse-cursor-rule.ts`) — via `splitFrontmatter`
 * and the `Text` scalar mode. Each old splitter answered "what does this
 * frontmatter say?" its own way (an indented `  id:` overwrote the record's id;
 * a BOM, a CRLF or a `--- ` line hid the whole block; a quoted comma split a
 * glob). This file keeps it at one answer:
 *
 *   (a) every non-test source file under packages/*\/src whose CODE detects a
 *       `---` frontmatter delimiter (a regex LITERAL holding `---` counts,
 *       anchored or not — review fix) is core's frontmatter directory or an
 *       EXEMPT row with its reason; a row that no longer detects one fails
 *       (two-way — an exemption cannot outlive its reason);
 *   (b) an exempt row that READS frontmatter hands the block to THE parser
 *       (it calls `parseFrontmatter(`);
 *   (c) no source outside core declares its own `function parseFrontmatter`
 *       (the cursor importer's private splitter had exactly that name);
 *   (d) the two migrated readers call `splitFrontmatter(` and
 *       `parseFrontmatter(` and carry no delimiter or line-splitting code.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { blankZoneKinds, lexCodeZones } from '@shrkcrft/boundaries';

// packages/cli/src/__tests__ → repo root is four levels up.
const REPO_ROOT = resolve(import.meta.dir, '../../../..');

/**
 * Code that finds a `---` frontmatter delimiter: an anchored `^---` pattern, a
 * `'---'` comparison, a `startsWith` / `indexOf` / `split` on `---` (or
 * `\n---`), a `*DELIMITER = '---'` constant. A writer's `lines.push('---')` or
 * template string is not detection.
 */
const DELIMITER_DETECTION: readonly RegExp[] = [
  /\^---/,
  /\b(?:startsWith|endsWith|indexOf|lastIndexOf|includes|split)\(\s*['"`](?:\\n)?---/,
  /(?:===|!==|==|!=)\s*['"`]---['"`]/,
  /['"`]---['"`]\s*(?:===|!==|==|!=)/,
  /\b[A-Z_]*DELIMITER[A-Z_]*\s*=\s*['"`]---/,
];

/** THE authority: core's frontmatter directory (`splitFrontmatter`, `parseFrontmatter`). */
const AUTHORITY = /^packages\/core\/src\/frontmatter\//;

interface IExemption {
  /** It READS frontmatter values — so it must hand the block to `parseFrontmatter(`. */
  readonly reads: boolean;
  readonly why: string;
}

/**
 * Every other file whose code detects a `---` line — each with WHY. Adding a
 * row needs a reason a reviewer accepts; a row whose file stops matching fails.
 */
const EXEMPT: Readonly<Record<string, IExemption>> = {
  'packages/generator/src/spec/spec-frontmatter.ts': {
    reads: true,
    why:
      'splitSpecMd — the sharkcraft.spec/v1 contract REFUSES a document without both delimiters (a Result error, ' +
      'not "no frontmatter") and keeps the raw block and body bytes the spec hashes (a normalising split would ' +
      're-hash a CRLF spec); every value is read by parseFrontmatter',
  },
  'packages/cli/src/commands/spec.command.ts': {
    reads: false,
    why: 'upsertPlanBlock — a WRITER that splices the plan: block into spec.md text and must keep every other byte; it never reads a value',
  },
  'packages/compress/src/content/detect-content-type.ts': {
    reads: false,
    why: 'unified-diff "--- a/file" header sniffing — not frontmatter',
  },
  'packages/compress/src/text/compress-diff.ts': {
    reads: false,
    why: 'unified-diff header / removed-line classification — not frontmatter',
  },
  'packages/compress/src/content/segment.ts': {
    reads: false,
    why: 'unified-diff segment sniffing (a regex literal matching the "--- a/file" header) — not frontmatter',
  },
};

/** The two readers the follow-up migrated. */
const MIGRATED: readonly string[] = [
  'packages/inspector/src/decision-records.ts',
  'packages/importer/src/parse/parse-cursor-rule.ts',
];

/**
 * Readers that split the document through THE split but keep a line partition
 * of their own for a reason — the Markdown knowledge loader's top-level block
 * partition feeds its dropped-key warnings (`unsupportedFrontmatterKeys`,
 * custom-checks). Round 15 closing (A2) retired its `FRONTMATTER_RE` exemption:
 * the regex missed a BOM file's frontmatter and read an unterminated block as
 * no frontmatter, silently.
 */
const SPLIT_READERS: readonly string[] = ['packages/knowledge/src/load/markdown-knowledge-loader.ts'];

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs)$/;

function walk(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name) && !/\.test\.[a-z]+$/.test(name)) out.push(full);
  }
}

/** Every non-test source file under packages/*\/src, repo-relative with `/`. */
function sourceFiles(): readonly string[] {
  const out: string[] = [];
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir)) walk(join(packagesDir, pkg, 'src'), out);
  return out.map((f) => relative(REPO_ROOT, f).split(sep).join('/')).sort();
}

/** The file's code with comments blanked (strings and regex literals kept). */
function codeOf(rel: string): string {
  const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
  return blankZoneKinds(text, lexCodeZones(text), new Set(['comment'] as const)).content;
}

/**
 * A regex LITERAL whose body holds `---` detects a delimiter by construction —
 * a writer never needs one — including unanchored forms (`/\n---\n/`,
 * `/(?:^|\n)---/`) no textual pattern above can tell from a template string.
 */
function regexLiteralDetects(code: string): boolean {
  return lexCodeZones(code).some((z) => z.regex === true && code.slice(z.start, z.end).includes('---'));
}

function detectsDelimiter(code: string): boolean {
  return DELIMITER_DETECTION.some((re) => re.test(code)) || regexLiteralDetects(code);
}

describe('r78 ONE frontmatter parser — the two-way lock', () => {
  const files = sourceFiles();

  test('the walk sees the tree (a broken walk would pass every lock vacuously)', () => {
    expect(files.length).toBeGreaterThan(500);
    for (const rel of [...Object.keys(EXEMPT), ...MIGRATED, ...SPLIT_READERS, 'packages/core/src/frontmatter/parse-frontmatter.ts']) {
      expect({ rel, walked: files.includes(rel) }).toEqual({ rel, walked: true });
    }
  });

  test('(a) only THE authority and the exempt rows detect a `---` delimiter', () => {
    const offenders = files.filter((rel) => !AUTHORITY.test(rel) && !(rel in EXEMPT) && detectsDelimiter(codeOf(rel)));
    expect(
      offenders.map(
        (rel) =>
          `${rel}: detects a --- frontmatter delimiter — read the document through splitFrontmatter + parseFrontmatter ` +
          '(@shrkcrft/core; FrontmatterScalarMode.Text for verbatim values), or add an EXEMPT row with the reason',
      ),
    ).toEqual([]);
  });

  test('(a) two-way: every exempt row still detects one (a stale exemption fails)', () => {
    const stale = Object.keys(EXEMPT).filter((rel) => !detectsDelimiter(codeOf(rel)));
    expect(stale.map((rel) => `${rel}: EXEMPT row no longer detects a --- delimiter — delete the row`)).toEqual([]);
  });

  test('(b) an exempt row that reads frontmatter hands the block to THE parser', () => {
    for (const [rel, row] of Object.entries(EXEMPT)) {
      if (!row.reads) continue;
      expect({ rel, callsParseFrontmatter: /\bparseFrontmatter\(/.test(codeOf(rel)) }).toEqual({
        rel,
        callsParseFrontmatter: true,
      });
    }
  });

  test('(c) no source outside core declares its own parseFrontmatter', () => {
    const shadows = files.filter(
      (rel) => !AUTHORITY.test(rel) && /\bfunction\s+parseFrontmatter\b|\bconst\s+parseFrontmatter\s*=/.test(codeOf(rel)),
    );
    expect(shadows).toEqual([]);
  });

  test('(d) the migrated readers call THE split and THE parser, and split no lines themselves', () => {
    for (const rel of MIGRATED) {
      const code = codeOf(rel);
      expect({
        rel,
        split: /\bsplitFrontmatter\(/.test(code),
        parse: /\bparseFrontmatter\(/.test(code),
        detectsDelimiter: detectsDelimiter(code),
        // The old splitters: `line.indexOf(':')` and `/^([A-Za-z][\w-]*)\s*:\s*(.*)$/`.
        keyValueSplit: /\.indexOf\(\s*['"]:['"]\s*\)|\(\[A-Za-z\]\[\\w-\]\*\)\\s\*:/.test(code),
      }).toEqual({ rel, split: true, parse: true, detectsDelimiter: false, keyValueSplit: false });
    }
  });

  test('(e) the Markdown knowledge loader splits through THE split and detects no delimiter itself (round 15 closing, A2)', () => {
    for (const rel of SPLIT_READERS) {
      const code = codeOf(rel);
      expect({
        rel,
        exempt: rel in EXEMPT,
        split: /\bsplitFrontmatter\(/.test(code),
        parse: /\bparseFrontmatter\(/.test(code),
        detectsDelimiter: detectsDelimiter(code),
      }).toEqual({ rel, exempt: false, split: true, parse: true, detectsDelimiter: false });
    }
  });

  test('the detector bites: the old splitters and unanchored regex forms are flagged, writers are not', () => {
    const flagged = [
      // HEAD's decision-records.ts and parse-cursor-rule.ts, verbatim.
      'const m = /^---\\n([\\s\\S]*?)\\n---\\n?([\\s\\S]*)$/.exec(text);',
      "if (!text.startsWith('---')) return { fm: {}, body: text };",
      "const end = text.indexOf('\\n---', 3);",
      // Unanchored regex literals — no textual pattern sees these.
      'const m = /\\n---\\n([\\s\\S]*?)\\n---/.exec(text);',
      'const parts = text.split(/(?:^|\\n)---\\s*\\n/);',
      "if (lines[0] === '---') open = true;",
    ];
    for (const snippet of flagged) expect({ snippet, detects: detectsDelimiter(snippet) }).toEqual({ snippet, detects: true });
    const writers = [
      "lines.push('---');",
      'const s = `---\\nid: ${id}\\n---\\n`;',
      "process.stdout.write('\\n--- preview ---\\n');",
    ];
    for (const snippet of writers) expect({ snippet, detects: detectsDelimiter(snippet) }).toEqual({ snippet, detects: false });
  });
});
