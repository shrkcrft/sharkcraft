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
}

/**
 * Split `content` into contiguous code / string / comment zones.
 *
 * A lexer, not a parser: it recognises the C/JS-family string quotes
 * (`'`, `"`, `` ` ``) and comment forms (`//`, `/* … *\/`). Documented limits —
 * a regex literal containing `//` reads as a comment, and `#`-comment languages
 * are reported as code.
 */
export function lexCodeZones(content: string): readonly ICodeZone[] {
  const zones: ICodeZone[] = [];
  let codeStart = 0;
  const flushCode = (upTo: number): void => {
    if (upTo > codeStart) zones.push({ kind: 'code', start: codeStart, end: upTo });
  };
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
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
  const out = content.split('');
  const blankedSpans: IBlankedSpan[] = [];
  let blankedChars = 0;
  for (const z of zones) {
    if (zoneKeepsAt(zone, zones, z.start)) continue;
    for (let i = z.start; i < z.end && i < out.length; i += 1) {
      // Newlines survive so line numbers — and any `m`-flag anchor — hold.
      if (out[i] !== '\n') out[i] = ' ';
    }
    blankedSpans.push({ kind: z.kind, start: z.start, end: z.end });
    blankedChars += z.end - z.start;
  }
  return { content: out.join(''), blankedSpans, blankedChars };
}
