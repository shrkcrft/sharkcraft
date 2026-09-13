import type { ScanZone } from '@shrkcrft/core';
import { skipComment, skipString } from './scan-literals.ts';

/**
 * Which lexical zone of a file a character belongs to.
 *
 * The dominant false positive of a text-based policy rule is a hit inside a
 * comment ("we used to call Date.now() here") or inside an unrelated string.
 * The dominant false NEGATIVE of a language-scoped linter is the opposite: it
 * cannot see inside an inline `template:` string at all. Classifying zones
 * lexically lets one rule say which of the three it means — without a parser,
 * and identically across `.ts`, `.kt`, `.scss` and friends.
 */
export type CodeZoneKind = 'code' | 'string' | 'comment';

/** A half-open `[start, end)` span of one zone kind. */
export interface ICodeZone {
  readonly kind: CodeZoneKind;
  readonly start: number;
  readonly end: number;
  /**
   * Set on a `string` zone delimited by BACKTICKS.
   *
   * A template literal is the one string form that routinely carries real
   * content a rule must see — an inline `template:`, a SQL/GraphQL tagged
   * query. Tagging it lets `code-and-templates` keep those bodies while still
   * blanking comments and plain quoted strings, without a second lexer.
   */
  readonly template?: boolean;
  /**
   * Set on a `code` zone that is one REGEX LITERAL (`/…/flags`).
   *
   * A regex literal is code, but its body is opaque: the backtick in
   * `` /`/g `` must not open a template literal and the `/*` in `/\/*$/` must
   * not open a block comment. Either mis-lex used to swallow every real
   * construct up to the next backtick / `*\/` in the file — a real `import()`
   * after it vanished from the code zone, and every boundary surface passed
   * over a forbidden import (round 11 review).
   */
  readonly regex?: boolean;
}

/** Characters after which a `/` starts an EXPRESSION (a regex literal), never a division. */
const REGEX_AFTER_PUNCTUATION: ReadonlySet<string> = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';',
  '+', '-', '*', '%', '<', '>', '~', '^', '/',
]);

/** Keywords after which a `/` starts a regex literal (`return /x/.test(s)`). */
const REGEX_AFTER_KEYWORD: ReadonlySet<string> = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'yield', 'await', 'instanceof', 'else', 'do',
]);

const isIdentifierChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);
const isBlank = (c: string): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

/**
 * Is a `/` whose previous significant code character sits at `prev` in
 * EXPRESSION position — i.e. does it open a regex literal rather than divide?
 * `prev < 0` is the start of the file. After an operand (an identifier, a
 * number, `)` or `]`) it is a division; after an operator, an opening bracket
 * or one of {@link REGEX_AFTER_KEYWORD} it is a regex. `)` is judged a division
 * on purpose: `(a + b) / 2` is far more common than `if (x) /re/.test(y)`, and
 * a missed regex only falls back to the pre-round-11 reading.
 */
function regexMayStartAfter(content: string, prev: number): boolean {
  if (prev < 0) return true;
  const ch = content[prev]!;
  if (REGEX_AFTER_PUNCTUATION.has(ch)) return true;
  if (!isIdentifierChar(ch)) return false;
  let start = prev;
  while (start > 0 && isIdentifierChar(content[start - 1])) start -= 1;
  // `obj.return / 2` — a property named like a keyword is an operand.
  if (start > 0 && content[start - 1] === '.') return false;
  return REGEX_AFTER_KEYWORD.has(content.slice(start, prev + 1));
}

/**
 * If a regex literal starts at `start` (a `/` already judged to be in
 * expression position, not followed by `/` or `*`), the index of its LAST
 * character (the closing `/`, or its last flag); otherwise `-1`.
 *
 * Bounded to the line — a regex literal cannot contain a line terminator — so
 * a `/` misjudged as a regex start costs at most the rest of one line, and a
 * lone division with no closing `/` on its line is not a regex at all. A `/`
 * inside a `[...]` class does not close the literal; `\` escapes one character.
 */
function skipRegexLiteral(content: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < content.length; i += 1) {
    const c = content[i]!;
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') {
      const next = content[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return -1;
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '/') {
      let end = i;
      while (end + 1 < content.length && /[A-Za-z]/.test(content[end + 1]!)) end += 1;
      return end;
    }
  }
  return -1;
}

/**
 * Does the `/` at `i` open a regex literal? Judged LAZILY, only for the rare
 * `/` that is not a comment: scan back over blanks to the previous significant
 * code character. The pending code region is `[codeStart, i)`; before it, the
 * recorded zones partition `[0, codeStart)` — a comment is trivia (keep
 * scanning before it), a string or regex literal is an operand (so the `/`
 * divides), a code zone is scanned like the pending region, and running out of
 * zones is the start of the file.
 *
 * This is exactly the previous-significant-character judgement the lexer used
 * to track EAGERLY on every character (round 11 review: that bookkeeping made
 * `lexCodeZones` ~1.8x slower under every zoned plane and the import parser).
 */
function slashOpensRegex(content: string, zones: readonly ICodeZone[], codeStart: number, i: number): boolean {
  let lo = codeStart;
  let j = i - 1;
  let z = zones.length - 1;
  for (;;) {
    while (j >= lo && isBlank(content[j]!)) j -= 1;
    if (j >= lo) return regexMayStartAfter(content, j);
    if (z < 0) return true;
    const zone = zones[z]!;
    z -= 1;
    if (zone.kind === 'comment') {
      lo = zone.start;
      j = zone.start - 1;
      continue;
    }
    if (zone.kind === 'string' || zone.regex === true) return false;
    lo = zone.start;
    j = zone.end - 1;
  }
}

/**
 * Memo of `lexCodeZones`, keyed by the CONTENT itself — so an entry can never
 * be stale (the key IS the bytes), even across a spawn or a write. Enabled only
 * inside {@link withLexCache}: one `shrk quality` run lexes the same file under
 * the plane check, the coverage pass and every zoned rule of both; within a
 * window each distinct content is lexed once. Bounded, and cleared when the
 * outermost window closes.
 */
const LEX_MEMO = new Map<string, readonly ICodeZone[]>();
const LEX_MEMO_LIMIT = 50_000;
let lexWindowDepth = 0;
let lexCount = 0;
let lexMemoHits = 0;

/** Run `fn` with the `lexCodeZones` memo enabled (nestable), then clear it. */
export function withLexCache<T>(fn: () => T): T {
  lexWindowDepth += 1;
  try {
    return fn();
  } finally {
    lexWindowDepth -= 1;
    if (lexWindowDepth === 0) LEX_MEMO.clear();
  }
}

/** How many contents were actually lexed, and how many lexes the memo served (tests / perf locks). */
export function lexCodeZonesStats(): { readonly lexed: number; readonly memoHits: number } {
  return { lexed: lexCount, memoHits: lexMemoHits };
}

/** Reset {@link lexCodeZonesStats}. */
export function resetLexCodeZonesStats(): void {
  lexCount = 0;
  lexMemoHits = 0;
}

/**
 * Split `content` into contiguous code / string / comment zones.
 *
 * A lexer, not a parser: it recognises the C/JS-family string quotes
 * (`'`, `"`, `` ` ``), comment forms (`//`, `/* … *\/`) and regex literals.
 * A `/` in expression position opens a regex literal (a `code` zone tagged
 * `regex`, see {@link ICodeZone.regex}) whose quotes, backticks and `/*` open
 * nothing. Documented limits — `#`-comment languages are reported as code, and
 * a regex right after `)` (`if (x) /re/`) is read as a division, i.e. with the
 * pre-round-11 lexing of its body.
 *
 * Inside {@link withLexCache} the result is memoised by content and shared
 * (frozen) between callers.
 */
export function lexCodeZones(content: string): readonly ICodeZone[] {
  if (lexWindowDepth > 0) {
    const hit = LEX_MEMO.get(content);
    if (hit !== undefined) {
      lexMemoHits += 1;
      return hit;
    }
  }
  const zones = lexUncached(content);
  lexCount += 1;
  if (lexWindowDepth > 0) {
    if (LEX_MEMO.size >= LEX_MEMO_LIMIT) LEX_MEMO.clear();
    const frozen = Object.freeze(zones);
    LEX_MEMO.set(content, frozen);
    return frozen;
  }
  return zones;
}

function lexUncached(content: string): ICodeZone[] {
  const zones: ICodeZone[] = [];
  let codeStart = 0;
  const flushCode = (upTo: number): void => {
    if (upTo > codeStart) zones.push({ kind: 'code', start: codeStart, end: upTo });
  };
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i]!;
    if (c === '"' || c === "'" || c === '`') {
      flushCode(i);
      const end = skipString(content, i);
      zones.push({
        kind: 'string',
        start: i,
        end: end + 1,
        ...(c === '`' ? { template: true } : {}),
      });
      i = end;
      codeStart = i + 1;
      continue;
    }
    if (c === '/') {
      const end = skipComment(content, i);
      if (end >= 0) {
        flushCode(i);
        zones.push({ kind: 'comment', start: i, end: end + 1 });
        i = end;
        codeStart = i + 1;
        continue;
      }
      if (slashOpensRegex(content, zones, codeStart, i)) {
        const reEnd = skipRegexLiteral(content, i);
        if (reEnd >= 0) {
          flushCode(i);
          zones.push({ kind: 'code', start: i, end: reEnd + 1, regex: true });
          i = reEnd;
          codeStart = i + 1;
          continue;
        }
      }
    }
  }
  flushCode(content.length);
  return zones;
}

/**
 * Zone kind at a character offset. `code` when the offset falls outside every
 * recorded zone (e.g. past end-of-content).
 */
export function zoneAt(zones: readonly ICodeZone[], index: number): CodeZoneKind {
  // Zones are contiguous and ascending — binary search.
  let lo = 0;
  let hi = zones.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const z = zones[mid]!;
    if (index < z.start) hi = mid - 1;
    else if (index >= z.end) lo = mid + 1;
    else return z.kind;
  }
  return 'code';
}

/**
 * The lexed zone containing `index` (`undefined` past the end) — for a caller
 * that needs a zone's BOUNDS, not just its kind: the import parser requires a
 * specifier's quote to OPEN a string, which "is inside a string" cannot tell
 * apart from a quote sitting inside a template literal.
 */
export function zoneContaining(zones: readonly ICodeZone[], index: number): ICodeZone | undefined {
  let lo = 0;
  let hi = zones.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const z = zones[mid]!;
    if (index < z.start) hi = mid - 1;
    else if (index >= z.end) lo = mid + 1;
    else return z;
  }
  return undefined;
}

/**
 * Does `zone` keep a match starting at `index`?
 *
 * The ONE place that maps a {@link ScanZone} onto a lexed offset. Both raw-text
 * engines call it — the policy plane per finding, the extraction DSL through
 * {@link blankOutsideZone} — so "what does `code` mean" cannot drift between
 * the two planes an author moves a rule between.
 *
 * Narrower zones require the match to START in the named zone: a pattern
 * spanning out of a comment is judged by where it began, which is the only
 * offset a regex engine reports.
 */
export function zoneKeepsAt(
  zone: ScanZone,
  zones: readonly ICodeZone[],
  index: number,
): boolean {
  if (zone === 'all') return true;
  let lo = 0;
  let hi = zones.length - 1;
  let hit: ICodeZone | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const z = zones[mid]!;
    if (index < z.start) hi = mid - 1;
    else if (index >= z.end) lo = mid + 1;
    else {
      hit = z;
      break;
    }
  }
  // Outside every recorded zone (e.g. past end-of-content) reads as code.
  const kind: CodeZoneKind = hit?.kind ?? 'code';
  if (zone === 'code') return kind === 'code';
  if (zone === 'strings') return kind === 'string';
  if (zone === 'comments') return kind === 'comment';
  // code-and-templates
  return kind === 'code' || (kind === 'string' && hit?.template === true);
}

/** A run of characters {@link blankOutsideZone} replaced with whitespace. */
export interface IBlankedSpan {
  readonly kind: CodeZoneKind;
  readonly start: number;
  readonly end: number;
}

/** What {@link blankOutsideZone} produced, plus what it had to remove to get there. */
export interface IBlankedContent {
  /** Same LENGTH as the input — every dropped character became a space or newline. */
  readonly content: string;
  readonly blankedSpans: readonly IBlankedSpan[];
  readonly blankedChars: number;
}

/**
 * Return `content` with every span OUTSIDE `zone` replaced by equal-length
 * whitespace.
 *
 * Blanking rather than deleting is the load-bearing detail: the result has the
 * same length and the same newlines as the input, so every offset and every
 * line number a downstream extractor reports is still the real one in the real
 * file. That is what lets a zone apply to EVERY extractor kind — `array-members`,
 * `call-args`, `object-keys` — instead of only the regex form, for free and with
 * no per-extractor zone logic to keep in sync.
 */
export function blankOutsideZone(content: string, zone: ScanZone): IBlankedContent {
  if (zone === 'all') return { content, blankedSpans: [], blankedChars: 0 };
  const zones = lexCodeZones(content);
  return blankZonesWhere(content, zones, (z) => !zoneKeepsAt(zone, zones, z.start));
}

/**
 * Blank every lexed zone whose KIND is in `kinds`, keeping everything else.
 *
 * The import extractor needs the one shape no {@link ScanZone} expresses:
 * comments gone (so a commented-out import is not an edge, and an apostrophe
 * in a comment cannot cut a real import clause short) while string literals
 * stay (the specifier IS a string). `zones` is passed in so a caller that also
 * judges offsets against the lex does not lex twice. Same blanking loop as
 * {@link blankOutsideZone} — one implementation of "blank a zone".
 */
export function blankZoneKinds(
  content: string,
  zones: readonly ICodeZone[],
  kinds: ReadonlySet<CodeZoneKind>,
): IBlankedContent {
  return blankZonesWhere(content, zones, (z) => kinds.has(z.kind));
}

/**
 * The ONE blanking loop: replace each selected zone with equal-length
 * whitespace. Newlines survive so line numbers — and any `m`-flag anchor —
 * hold. Built from slices (not a per-character array) so a large file costs
 * one pass.
 */
function blankZonesWhere(
  content: string,
  zones: readonly ICodeZone[],
  blank: (z: ICodeZone) => boolean,
): IBlankedContent {
  const parts: string[] = [];
  const blankedSpans: IBlankedSpan[] = [];
  let blankedChars = 0;
  let cursor = 0;
  for (const z of zones) {
    if (!blank(z)) continue;
    const start = Math.min(z.start, content.length);
    const end = Math.min(z.end, content.length);
    if (start > cursor) parts.push(content.slice(cursor, start));
    parts.push(content.slice(start, end).replace(/[^\n]/g, ' '));
    cursor = end;
    blankedSpans.push({ kind: z.kind, start: z.start, end: z.end });
    blankedChars += z.end - z.start;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));
  return { content: parts.join(''), blankedSpans, blankedChars };
}
