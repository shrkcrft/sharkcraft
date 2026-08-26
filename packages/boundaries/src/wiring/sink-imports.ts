import { lineOf } from '../extract/scan-literals.ts';
import { parseImportStatements } from '../extract/parse-imports.ts';

/**
 * Import analysis for a wiring SINK file.
 *
 * `check wiring --fix` appends a token to a registry array. That edit is only
 * safe when the token actually RESOLVES in the sink file. The common registry
 * shape imports every member:
 *
 * ```ts
 * import { ALPHA_HANDLER } from './ALPHA_HANDLER';
 * export const HANDLERS = [ALPHA_HANDLER];
 * ```
 *
 * Appending `NEW_HANDLER` to that array turns the wiring gate GREEN while
 * leaving the file referencing an unbound symbol — it no longer compiles. A
 * gate that goes green by breaking the build is the exact inverse of the
 * point, so the planner has to know what the sink file binds before it writes.
 *
 * This is a lexer, not a compiler: it answers "is this name bound in this
 * file?" and "do the existing members follow one derivable import pattern?" —
 * both of which are decidable from the text, and neither of which is guessed.
 */

/** How a name entered the file's scope. */
export type SinkBindingKind = 'named-import' | 'default-import' | 'namespace-import' | 'local';

/** One value binding visible in the sink file. */
export interface ISinkBinding {
  /** The name as used in the file (the local name, after any `as` alias). */
  readonly local: string;
  readonly kind: SinkBindingKind;
  /** The exported name, for a named import (differs from `local` when aliased). */
  readonly imported?: string;
  /** Module specifier, for an import binding. */
  readonly specifier?: string;
}

/** Top-level value/type declarations — the names a file binds itself. */
const LOCAL_DECL =
  /(?:^|\n)\s*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:const|let|var|function\s*\*?|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g;

/**
 * Every value name bound in the file: imports plus its own top-level
 * declarations.
 *
 * Local declarations count because a registry that declares its members inline
 * needs no import at all — refusing to fix those would be a false refusal.
 */
export function collectSinkBindings(content: string): ISinkBinding[] {
  const bindings: ISinkBinding[] = [];
  for (const statement of parseImportStatements(content)) {
    // A type-only import binds no VALUE, so it can never make an array element
    // resolve. Counting it would let the planner write a reference that erases
    // at compile time.
    if (statement.typeOnly) continue;
    for (const b of statement.bindings) {
      bindings.push({
        local: b.local,
        kind: `${b.kind}-import` as SinkBindingKind,
        ...(b.imported !== undefined ? { imported: b.imported } : {}),
        specifier: statement.specifier,
      });
    }
  }
  LOCAL_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOCAL_DECL.exec(content)) !== null) {
    bindings.push({ local: m[1]!, kind: 'local' });
  }
  return bindings;
}

/** Whether `name` already resolves in the sink file. */
export function isBoundInSink(content: string, name: string): boolean {
  return collectSinkBindings(content).some((b) => b.local === name);
}

/** A uniform import pattern the existing members all follow. */
export interface IImportTemplate {
  /** The specifier with every occurrence of the member name replaced by `{}`. */
  readonly specifierTemplate: string;
  /** Quote character used by the existing imports. */
  readonly quote: string;
  /** Whether existing import statements end in a semicolon. */
  readonly semicolon: boolean;
  /** How many members the template was derived from. */
  readonly derivedFrom: number;
}

/**
 * Derive the import pattern the sink's existing members follow, if there is
 * exactly one.
 *
 * Derivation succeeds only when the specifier is a pure FUNCTION OF THE MEMBER
 * NAME — every member `M` imported as `import { M } from '<something>M<something>'`
 * with the same surrounding text. A barrel (`from './handlers'`), mixed paths,
 * or an aliased import make the next specifier unknowable, and the planner must
 * never invent a path: those return `undefined` so the caller refuses instead.
 */
export function deriveImportTemplate(
  content: string,
  members: readonly string[],
): IImportTemplate | undefined {
  const bindings = collectSinkBindings(content);
  const byLocal = new Map(bindings.map((b) => [b.local, b] as const));

  let template: string | undefined;
  let derivedFrom = 0;
  for (const member of members) {
    const binding = byLocal.get(member);
    if (!binding || binding.kind === 'local') continue;
    // An alias means the local name is NOT the exported name, so the next
    // token's exported name cannot be derived from the name we would write.
    if (binding.kind !== 'named-import' || binding.imported !== binding.local) return undefined;
    if (!binding.specifier || !binding.specifier.includes(member)) return undefined;
    const candidate = binding.specifier.split(member).join('{}');
    if (template === undefined) template = candidate;
    else if (template !== candidate) return undefined;
    derivedFrom += 1;
  }
  if (template === undefined || derivedFrom === 0) return undefined;

  // Mirror the file's existing punctuation so the inserted line does not fight
  // the formatter that will run over it next.
  const raw = parseImportStatements(content).find((st) => st.kind === 'import')?.raw ?? '';
  return {
    specifierTemplate: template,
    quote: raw.includes('"') ? '"' : "'",
    semicolon: raw.trimEnd().endsWith(';'),
    derivedFrom,
  };
}

/** Render the import statement this template produces for `token`. */
export function renderImport(template: IImportTemplate, token: string): string {
  const specifier = template.specifierTemplate.split('{}').join(token);
  return `import { ${token} } from ${template.quote}${specifier}${template.quote}${template.semicolon ? ';' : ''}`;
}

/** The specifier a template yields for `token`, without the surrounding syntax. */
export function renderSpecifier(template: IImportTemplate, token: string): string {
  return template.specifierTemplate.split('{}').join(token);
}

/** Where a new import line goes, and the resulting content. */
export interface IImportInsertion {
  readonly nextContent: string;
  /** 1-based line the inserted statement lands on. */
  readonly line: number;
}

/**
 * Insert an import statement after the LAST existing import.
 *
 * Appending to the import block (rather than sorting into it) keeps the edit a
 * pure insertion: no existing line moves, so the diff shows exactly one added
 * line and a reviewer can see the whole change at a glance.
 */
export function insertImportStatement(
  content: string,
  statement: string,
): IImportInsertion | undefined {
  // Only the STATIC import block is a valid insertion point: landing after a
  // dynamic `import()` deep in the file would put a top-level import in the
  // middle of a function body.
  const statements = parseImportStatements(content).filter((st) => st.kind === 'import');
  const last = statements[statements.length - 1];
  if (!last) return undefined;

  const endOfLast = last.index + last.raw.length;
  // Land immediately after the statement's own newline so the insertion never
  // splits a line, whatever trails the specifier.
  const newline = content.indexOf('\n', endOfLast);
  const at = newline === -1 ? content.length : newline + 1;
  const nextContent = content.slice(0, at) + statement + '\n' + content.slice(at);
  return { nextContent, line: lineOf(nextContent, at) };
}
