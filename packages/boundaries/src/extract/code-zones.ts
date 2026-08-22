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
      zones.push({ kind: 'string', start: i, end: end + 1 });
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
