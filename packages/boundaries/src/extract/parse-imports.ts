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
 */

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
 * contains a `;` or a quote, which is what keeps the lazy match from running
 * past the end of its own statement into the next one.
 *
 * `export … from '…'` is matched too: a re-export is an edge in the dependency
 * graph exactly like an import, and a barrel that is invisible here would make
 * every consumer behind it invisible as well.
 */
const IMPORT_STATEMENT = /\b(import|export)\s+([^;'"]*?)\s*from\s*['"]([^'"]+)['"]\s*;?/g;

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

/** 1-based line number of `index` within `content`. */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Every import / re-export statement in `content`, with the names it binds.
 *
 * A `import type { … }` statement is returned with `typeOnly: true` rather than
 * dropped: the `--fix` planner must ignore it (it binds no value), while the
 * dependency graph legitimately counts it as an edge. Returning it and letting
 * each caller decide keeps that judgement at the call site instead of baking
 * one feature's answer into the shared parser.
 */
export function parseImportStatements(content: string): IParsedImport[] {
  const out: IParsedImport[] = [];
  const claimed: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;

  IMPORT_STATEMENT.lastIndex = 0;
  while ((m = IMPORT_STATEMENT.exec(content)) !== null) {
    const clause = m[2]!;
    const typeOnly = /^type\b/.test(clause.trim());
    claimed.push({ start: m.index, end: m.index + m[0].length });
    out.push({
      specifier: m[3]!,
      bindings: typeOnly ? [] : parseClause(clause),
      line: lineAt(content, m.index),
      index: m.index,
      raw: m[0]!,
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
    while ((m = re.exec(content)) !== null) {
      if (overlapsClaimed(m.index)) continue;
      out.push({
        specifier: m[1]!,
        bindings: [],
        line: lineAt(content, m.index),
        index: m.index,
        raw: m[0]!,
        typeOnly: false,
        kind,
      });
    }
  }

  return out.sort((a, b) => a.index - b.index);
}
