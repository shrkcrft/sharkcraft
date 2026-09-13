/**
 * The ONE import-statement parser.
 *
 * Two features need to read import statements out of source text: the
 * `--fix` planner (does this sink bind the token, and how?) and the
 * `import-edges` extractor (which file imports what, from where?). A second
 * parser would drift from the first, and the two would then disagree about
 * what a file imports — which is precisely the class of silent disagreement
 * this engine exists to eliminate. So both consume this.
 *
 * It is a lexer, not a compiler: it answers what the text says, which is the
 * largest thing that stays honest across `.ts`, `.tsx`, `.mts` and plain JS
 * with one code path.
 *
 * Round 11 (6.1a) made it the ONLY import extractor: `scanImports` (every
 * boundary check, drift, impact, review packet…) and the `import-edges` DSL
 * extractor both read through here, so "what does this file import" has one
 * answer. By default it reads CODE only — a commented-out import, an import in
 * a doc-comment code fence, or `"import x from 'y'"` inside a string is not a
 * dependency. Measured against the TypeScript oracle over this repo (1716
 * files): 79 phantom edges and 1 real miss before, 0 / 0 after.
 */
import {
  blankZoneKinds,
  lexCodeZones,
  zoneContaining,
  zoneKeepsAt,
  type CodeZoneKind,
} from './code-zones.ts';

/**
 * Which text an import statement may be read from.
 *
 *   - `code` (the default): the statement's keyword must start in executable
 *     code and its specifier must be a real string literal; comments are
 *     blanked before matching, so an apostrophe inside a comment within a
 *     multi-line clause can no longer cut a real import short.
 *   - `all`: the raw file text — every byte, comments included. The explicit
 *     escape hatch (`check boundaries --include-comments`, `scan: 'all'`).
 */
export type ImportParseZone = 'code' | 'all';

/** Options for {@link parseImportStatements}. */
export interface IParseImportsOptions {
  /** Default `code`. */
  readonly zone?: ImportParseZone;
}

/** How a name entered scope through an import. */
export type ImportBindingKind = 'named' | 'default' | 'namespace';

/** One name bound by an import statement. */
export interface IImportBinding {
  /** The name as used in the file (after any `as` alias). */
  readonly local: string;
  readonly kind: ImportBindingKind;
  /** The exported name, for a named import (differs from `local` when aliased). */
  readonly imported?: string;
}

/**
 * How the dependency was expressed.
 *
 * `--fix` only ever extends the STATIC import block, so it filters on this;
 * the dependency graph counts every kind, because a fence that missed
 * `await import('../secret')` would have a hole exactly where someone
 * motivated would put one.
 */
export type ImportStatementKind = 'import' | 'reexport' | 'side-effect' | 'dynamic' | 'require';

/** One parsed dependency statement. */
export interface IParsedImport {
  readonly specifier: string;
  readonly bindings: readonly IImportBinding[];
  /** 1-based line of the statement's start. */
  readonly line: number;
  /** Character offset of the statement's start. */
  readonly index: number;
  /** The matched statement text, for style detection (quotes, semicolons). */
  readonly raw: string;
  /** True for `import type { … }` — binds no runtime value. */
  readonly typeOnly: boolean;
  readonly kind: ImportStatementKind;
}

/**
 * Matches one import/re-export statement up to its specifier.
 *
 * The clause may span lines (a multi-line `{ … }` block is normal) but never
 * contains a `;`, a quote or a BACKTICK, which is what keeps the lazy match
 * from running past the end of its own statement into the next one. No real
 * import clause holds a backtick; prose does — a doc comment's
 * `` `shrk import <format> --populate` `` used to open a clause that ran on to
 * the next real `from '…'`, so the raw reading (`--include-comments`,
 * `scan: 'all'`) filed that import on the comment's line. The old scanImports
 * regex excluded the backtick too; raw-mode lines match it again.
 *
 * `export … from '…'` is matched too: a re-export is an edge in the dependency
 * graph exactly like an import, and a barrel that is invisible here would make
 * every consumer behind it invisible as well.
 *
 * Linear by construction (round 11, 6.1(b)): the old form
 * `\s+([^;'"]*?)\s*from` put three whitespace-consuming quantifiers side by
 * side, which is fine on raw source and O(run²) once comments are blanked into
 * long runs of spaces (6 / 24 / 94 / 371 ms as a JSDoc block doubled). Here a
 * single `\s` separates the keyword from ONE lazy class, and `\bfrom` needs no
 * whitespace quantifier in front of it, so each keyword costs one forward scan
 * to its statement's end. Verified byte-identical to the old form on the raw
 * text of every file in this repo. Do not reintroduce adjacent `\s*`/`\s+`
 * around a lazy class — `r75-import-scan-zones.test.ts` times it.
 */
const IMPORT_STATEMENT = /\b(import|export)\s([^;'"`]*?)\bfrom\s*['"]([^'"]+)['"]\s*;?/g;

/**
 * The specifier-only forms, which bind no name: a side-effect import, a dynamic
 * `import()`, and `require()`. Each is a real dependency edge — the boundary
 * engine counts all three — even though none of them introduces a binding.
 */
const SIDE_EFFECT_IMPORT = /\bimport\s*['"]([^'"]+)['"]\s*;?/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Split a clause on commas that are OUTSIDE a `{ … }` block. */
function splitTopLevel(clause: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of clause) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') out.push(current);
  return out;
}

/** Parse the clause between `import`/`export` and `from`. */
function parseClause(clause: string): IImportBinding[] {
  const bindings: IImportBinding[] = [];
  for (const part of splitTopLevel(clause.trim())) {
    const piece = part.trim();
    if (piece === '') continue;

    if (piece.startsWith('*')) {
      const m = /^\*\s*as\s+([A-Za-z_$][\w$]*)$/.exec(piece);
      if (m) bindings.push({ local: m[1]!, kind: 'namespace' });
      continue;
    }

    if (piece.startsWith('{')) {
      const inner = piece.replace(/^\{/, '').replace(/\}$/, '');
      for (const spec of inner.split(',')) {
        const s = spec.trim();
        // An inline `type` specifier binds no runtime value.
        if (s === '' || /^type\b/.test(s)) continue;
        const aliased = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(s);
        if (aliased) {
          bindings.push({ local: aliased[2]!, kind: 'named', imported: aliased[1]! });
          continue;
        }
        if (/^[A-Za-z_$][\w$]*$/.test(s)) {
          bindings.push({ local: s, kind: 'named', imported: s });
        }
      }
      continue;
    }

    if (/^[A-Za-z_$][\w$]*$/.test(piece)) {
      bindings.push({ local: piece, kind: 'default' });
    }
  }
  return bindings;
}

/** Offsets of every `\n` in `content`, for O(log n) line lookups. */
function newlineOffsets(content: string): number[] {
  const out: number[] = [];
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) out.push(i);
  return out;
}

/**
 * 1-based line of `index`: one plus the number of newlines BEFORE it. The
 * index is the keyword's own offset — the old `scanImports` regex consumed the
 * preceding `\n` with `(?:^|\s)`, so every import after line 1 was reported
 * one line early (round 11, 6.1a#line-numbers).
 */
function lineAt(newlines: readonly number[], index: number): number {
  let lo = 0;
  let hi = newlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newlines[mid]! < index) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/** Zones blanked before matching in `code` mode: comments only — the specifier is a string. */
const COMMENT_ZONES: ReadonlySet<CodeZoneKind> = new Set<CodeZoneKind>(['comment']);

/**
 * Offset (within the match) of the specifier's OPENING quote. Every pattern
 * ends `<quote><specifier><quote>` followed only by whitespace, `;` or `)`,
 * and no clause may contain a quote, so the last quote in the match closes the
 * specifier.
 */
function specifierQuoteOffset(match: string, specifier: string): number {
  const closing = Math.max(match.lastIndexOf("'"), match.lastIndexOf('"'));
  return closing - specifier.length - 1;
}

/**
 * Every import / re-export statement in `content`, with the names it binds.
 *
 * A `import type { … }` statement is returned with `typeOnly: true` rather than
 * dropped: the `--fix` planner must ignore it (it binds no value), while the
 * dependency graph legitimately counts it as an edge. Returning it and letting
 * each caller decide keeps that judgement at the call site instead of baking
 * one feature's answer into the shared parser.
 *
 * In the default `code` zone a statement is kept only when its keyword starts
 * in a code zone AND its specifier quote opens a real string literal — the
 * same {@link zoneKeepsAt} authority the policy plane and the extraction DSL
 * use. Offsets, lines and `raw` always refer to the ORIGINAL text (blanking
 * preserves length), so callers that splice `content` stay correct.
 */
export function parseImportStatements(
  content: string,
  options: IParseImportsOptions = {},
): IParsedImport[] {
  return parseImportStatementsWithMeta(content, options).statements;
}

/**
 * {@link parseImportStatements}, plus how many characters the zone BLANKED
 * before matching: the comment characters under `code`, `0` under `all`.
 *
 * The `import-edges` extractor zones itself (a pre-blanked buffer would erase
 * every specifier), so this is the figure it reports as its `blankedChars` —
 * the number `wiring explain` / `gates explain` print as
 * `scan: code (N chars blanked)`. Without it the note claimed a zone removed
 * nothing while it had dropped a commented-out edge.
 */
export function parseImportStatementsWithMeta(
  content: string,
  options: IParseImportsOptions = {},
): { readonly statements: IParsedImport[]; readonly blankedChars: number } {
  const zone: ImportParseZone = options.zone ?? 'code';
  const zones = zone === 'code' ? lexCodeZones(content) : undefined;
  const blanked = zones ? blankZoneKinds(content, zones, COMMENT_ZONES) : undefined;
  const text = blanked ? blanked.content : content;
  // Built on first use: a file whose statements are all zoned out (or that has
  // none) never needs a line table.
  let newlines: number[] | undefined;
  const lineOfIndex = (index: number): number => lineAt((newlines ??= newlineOffsets(content)), index);
  const keep = (index: number, match: string, specifier: string): boolean => {
    if (!zones) return true;
    const quote = index + specifierQuoteOffset(match, specifier);
    // The specifier's quote must OPEN a plain string literal. "Inside a string"
    // is not enough: `export const t = \`import z from 'w'\`` starts with a
    // code `export`, and its `'w'` sits inside the template literal.
    const specZone = zoneContaining(zones, quote);
    return (
      zoneKeepsAt('code', zones, index) &&
      zoneKeepsAt('strings', zones, quote) &&
      specZone !== undefined &&
      specZone.start === quote &&
      specZone.template !== true
    );
  };

  const out: IParsedImport[] = [];
  const claimed: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;

  IMPORT_STATEMENT.lastIndex = 0;
  while ((m = IMPORT_STATEMENT.exec(text)) !== null) {
    const specifier = m[3]!;
    if (!keep(m.index, m[0], specifier)) continue;
    const clause = m[2]!;
    const typeOnly = /^type\b/.test(clause.trim());
    claimed.push({ start: m.index, end: m.index + m[0].length });
    out.push({
      specifier,
      bindings: typeOnly ? [] : parseClause(clause),
      line: lineOfIndex(m.index),
      index: m.index,
      raw: content.slice(m.index, m.index + m[0].length),
      typeOnly,
      kind: m[1] === 'export' ? 'reexport' : 'import',
    });
  }

  // A `import x from 'y'` also contains the text `import … 'y'`, so the
  // specifier-only patterns would re-report it. Skipping anything inside an
  // already-claimed span keeps each dependency counted exactly once.
  const overlapsClaimed = (start: number): boolean =>
    claimed.some((c) => start >= c.start && start < c.end);

  for (const [re, kind] of [
    [SIDE_EFFECT_IMPORT, 'side-effect'],
    [DYNAMIC_IMPORT, 'dynamic'],
    [REQUIRE_CALL, 'require'],
  ] as const) {
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      if (overlapsClaimed(m.index)) continue;
      const specifier = m[1]!;
      if (!keep(m.index, m[0], specifier)) continue;
      out.push({
        specifier,
        bindings: [],
        line: lineOfIndex(m.index),
        index: m.index,
        raw: content.slice(m.index, m.index + m[0].length),
        typeOnly: false,
        kind,
      });
    }
  }

  return { statements: out.sort((a, b) => a.index - b.index), blankedChars: blanked?.blankedChars ?? 0 };
}
