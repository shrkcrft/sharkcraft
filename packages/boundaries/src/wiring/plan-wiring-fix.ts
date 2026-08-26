import type { IWiringRule, IWiringSource } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { elementToken, escapeRegex, scanBalanced } from '../extract/scan-literals.ts';
import { extractTokens } from '../extract/extract-tokens.ts';
import { registeredSources, type IWiringViolation } from './evaluate-wiring.ts';
import {
  collectSinkBindings,
  deriveImportTemplate,
  insertImportStatement,
  renderImport,
  renderSpecifier,
  type IImportTemplate,
} from './sink-imports.ts';
import { resolveExtractorAnchor, resolveExtractorKind } from '@shrkcrft/core';

export const WIRING_FIX_SCHEMA = 'sharkcraft.wiring-fix/v1' as const;

/** Why a violation could not be fixed mechanically. */
export type WiringFixRefusal =
  /** More than one registered sink — which array should it go in? */
  | 'ambiguous-sink'
  /** The sink is not an array literal the engine can append to. */
  | 'sink-not-an-array'
  /** The sink glob resolves to several files, or none. */
  | 'ambiguous-sink-file'
  /** The array literal could not be located in the sink file. */
  | 'array-not-found'
  /** The token is a quoted string in the sink; the declared side is a symbol (or vice versa). */
  | 'token-shape-mismatch'
  /**
   * The sink IMPORTS its array members, so appending to the array alone would
   * leave an unbound reference — a green gate over a file that does not
   * compile. Raised whenever the needed import cannot be derived with
   * certainty.
   */
  | 'needs-import';

/** One planned edit: append `token` into the anchor array of `file`. */
export interface IWiringFixEdit {
  readonly ruleId: string;
  readonly token: string;
  /** Project-relative sink file the edit lands in. */
  readonly file: string;
  /** 1-based line of the array's closing bracket, where the token is inserted before. */
  readonly line: number;
  /** The exact text inserted, including indentation and trailing comma. */
  readonly insert: string;
  /** The full new file contents, ready to write. */
  readonly nextContent: string;
  /**
   * The import statement added alongside the array append, when the sink
   * imports its members and the specifier was derivable. Absent when the token
   * was already bound in the sink file.
   */
  readonly importInsert?: string;
  /** 1-based line the import statement lands on. */
  readonly importLine?: number;
}

/** A violation the planner deliberately did not touch. */
export interface IWiringFixSkip {
  readonly ruleId: string;
  readonly token: string;
  readonly reason: WiringFixRefusal;
  readonly detail: string;
}

export interface IWiringFixPlan {
  readonly schema: typeof WIRING_FIX_SCHEMA;
  readonly edits: readonly IWiringFixEdit[];
  readonly skipped: readonly IWiringFixSkip[];
}

/** A file the planner may read/rewrite. */
export interface IWiringFixFile {
  readonly path: string;
  readonly content: string;
}

/** Indentation of the line containing `index`. */
function indentOf(content: string, index: number): string {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  const m = /^[ \t]*/.exec(content.slice(lineStart, index));
  return m ? m[0] : '  ';
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}


/** Extensions a derived specifier may resolve through, in probe order. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Resolve a relative specifier against the sink's directory, POSIX-style.
 *
 * Only relative specifiers are resolvable this way. A bare specifier is a
 * package (or a tsconfig alias) whose target this engine cannot know without a
 * resolver, so those are reported unresolved and the caller refuses.
 */
function resolveRelative(sinkPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const dir = sinkPath.includes('/') ? sinkPath.slice(0, sinkPath.lastIndexOf('/')) : '';
  const parts = [...dir.split('/').filter(Boolean), ...specifier.split('/')];
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

/**
 * Whether a derived specifier really points at the file that DECLARES the
 * token.
 *
 * This is the safety net that makes the derived-import path trustworthy rather
 * than merely plausible. The template says what the specifier *should* be; this
 * confirms it names the file the gate found the token in. A template that
 * happens to fit the existing members but misses for the new one is caught
 * here instead of being written to disk.
 */
function specifierPointsAtDeclaration(
  sinkPath: string,
  specifier: string,
  declaringFile: string,
): boolean {
  const base = resolveRelative(sinkPath, specifier);
  if (base === undefined) return false;
  if (base === declaringFile) return true;
  for (const ext of RESOLVE_EXTENSIONS) {
    if (base + ext === declaringFile) return true;
    if (`${base}/index${ext}` === declaringFile) return true;
  }
  return false;
}

/**
 * Whether `file` exports `token`, per the same extractor the declared side of a
 * rule most often uses.
 *
 * Reuses `extractTokens` rather than a second regex so "what counts as an
 * export" has exactly one definition — a private answer here that drifted from
 * the extractor would either block valid fixes or wave through invalid ones.
 */
function exportsToken(content: string, token: string): boolean {
  const res = extractTokens({ files: ['*'], extract: 'export-names' }, [{ path: 'x', content }]);
  return res.sites.some((site) => site.token === token);
}

/** The import decision for one token about to be appended to the sink. */
type IImportDecision =
  /** The array append alone is safe — no import statement is needed. */
  | { kind: 'append-only' }
  | { kind: 'derived'; template: IImportTemplate; statement: string }
  | { kind: 'refuse'; detail: string };

/**
 * Decide whether appending `token` to the sink needs an import, and whether
 * that import can be derived.
 *
 * The condition is an INCONSISTENCY check, not a resolvability check. An import
 * is needed exactly when the sink's existing members are import-bound but the
 * new token would not be — that is the case where the append introduces a
 * reference the file cannot resolve, and where the gate would go green over a
 * file that no longer compiles.
 *
 * Deliberately NOT "the token must be bound". If the existing members are
 * themselves unbound (ambient globals, a `/// <reference>`, a fixture), then
 * whatever makes them resolve applies equally to the new one, and the append is
 * consistent with the file's own convention. Refusing there would be a false
 * refusal on a file the edit does not make any worse.
 */
function decideImport(
  sinkPath: string,
  sinkContent: string,
  members: readonly string[],
  token: string,
  declaringFile: string | undefined,
  declaringContent: string | undefined,
): IImportDecision {
  const bindings = collectSinkBindings(sinkContent);
  // Already resolvable here — imported, or declared inline in the sink.
  if (bindings.some((b) => b.local === token)) return { kind: 'append-only' };

  // Only members brought in by an IMPORT establish a binding convention the new
  // token has to follow. A locally-declared member says nothing about where an
  // external one would come from.
  const importedMembers = members.filter((m) =>
    bindings.some((b) => b.local === m && b.kind !== 'local'),
  );
  // No member arrives by import, so there is no convention the new token is
  // breaking — the append leaves the file exactly as consistent as it was.
  if (importedMembers.length === 0) return { kind: 'append-only' };

  const template = deriveImportTemplate(sinkContent, members);
  if (!template) {
    return {
      kind: 'refuse',
      detail:
        `sink ${sinkPath} imports its members, but their import paths are not a function of the member name ` +
        '(a barrel, mixed paths, or an aliased import) — the specifier for this token cannot be derived',
    };
  }
  if (declaringFile === undefined) {
    return {
      kind: 'refuse',
      detail: `sink ${sinkPath} imports its members and the declaring file of "${token}" is unknown, so the import cannot be verified`,
    };
  }
  // A named import only works if the target actually EXPORTS the token. The
  // gate may have found it with any extractor (`regex-capture` over `const (\w+)`
  // matches un-exported locals too), so being declared there does not imply
  // being exported from there.
  if (declaringContent !== undefined && !exportsToken(declaringContent, token)) {
    return {
      kind: 'refuse',
      detail:
        `"${token}" is declared in ${declaringFile} but not exported from it — ` +
        'a named import would not resolve, so the array append is refused too',
    };
  }
  const specifier = renderSpecifier(template, token);
  if (!specifierPointsAtDeclaration(sinkPath, specifier, declaringFile)) {
    return {
      kind: 'refuse',
      detail:
        `sink ${sinkPath} imports its members; the derived specifier "${specifier}" does not resolve to ` +
        `${declaringFile}, where "${token}" is declared — refusing rather than writing a guess`,
    };
  }
  return { kind: 'derived', template, statement: renderImport(template, token) };
}

/**
 * Plan the mechanically-unambiguous fixes for `declared-but-not-registered`
 * violations.
 *
 * The bar is deliberately high, because a wrong autofix in a gate is worse than
 * no autofix: the tool would be writing the very thing it is supposed to
 * verify. An edit is planned ONLY when there is exactly one registered sink,
 * that sink is an `array-members` source, its glob resolves to exactly one
 * file, and the anchor array is found exactly once in it. Every other shape is
 * reported as skipped WITH the reason — never guessed at.
 *
 * Pure: the caller supplies file contents and performs any writes.
 */
export function planWiringFix(
  rule: IWiringRule,
  violations: readonly IWiringViolation[],
  files: readonly IWiringFixFile[],
): IWiringFixPlan {
  const edits: IWiringFixEdit[] = [];
  const skipped: IWiringFixSkip[] = [];
  const declaredMissing = violations.filter(
    (v) => v.ruleId === rule.id && v.direction === 'declared-missing',
  );
  if (declaredMissing.length === 0) return { schema: WIRING_FIX_SCHEMA, edits, skipped };

  const refuseAll = (reason: WiringFixRefusal, detail: string): IWiringFixPlan => ({
    schema: WIRING_FIX_SCHEMA,
    edits: [],
    skipped: declaredMissing.map((v) => ({ ruleId: rule.id, token: v.token, reason, detail })),
  });

  // A chain rule has no single "the sink"; refuse rather than pick one.
  const sinks: readonly IWiringSource[] = rule.chain
    ? []
    : registeredSources(rule.registered);
  if (sinks.length !== 1) {
    return refuseAll(
      'ambiguous-sink',
      sinks.length === 0
        ? 'rule has no single registered sink (chain rules are never auto-fixed)'
        : `rule has ${sinks.length} registered sinks — which one should the token join?`,
    );
  }
  const sink = sinks[0]!;
  if (resolveExtractorKind(sink) !== 'array-members') {
    return refuseAll(
      'sink-not-an-array',
      `sink uses extract "${resolveExtractorKind(sink) ?? 'unknown'}" — only an array literal can be appended to`,
    );
  }
  const anchor = resolveExtractorAnchor(sink);
  if (anchor === undefined) return refuseAll('sink-not-an-array', 'sink declares no anchor');

  const sinkFiles = files.filter((f) => matchesAny(f.path, sink.files ?? []));
  if (sinkFiles.length !== 1) {
    return refuseAll(
      'ambiguous-sink-file',
      `sink glob matched ${sinkFiles.length} files — the insertion point must be unique`,
    );
  }
  const target = sinkFiles[0]!;

  // Locate the anchor array. More than one occurrence is ambiguous.
  const head = new RegExp(
    `(?<![\\w$])${escapeRegex(anchor)}\\s*(?::[^=\\n]*)?[:=]\\s*(?:[A-Za-z_$][\\w$.]*\\s*\\(\\s*)?\\[`,
    'g',
  );
  const opens: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = head.exec(target.content)) !== null) opens.push(m.index + m[0].length - 1);
  if (opens.length !== 1) {
    return refuseAll(
      'array-not-found',
      opens.length === 0
        ? `array \`${anchor}\` not found in ${target.path}`
        : `array \`${anchor}\` appears ${opens.length} times in ${target.path}`,
    );
  }

  const openIndex = opens[0]!;
  const { elements, end } = scanBalanced(target.content, openIndex);
  // Match the shape of what is already in the array: bare identifiers vs
  // quoted strings. Inserting the wrong shape would compile-fail or silently
  // not match on the next run.
  const firstEl = elements[0]?.text ?? '';
  const quoted = firstEl.startsWith("'") || firstEl.startsWith('"');
  const quoteChar = firstEl.startsWith('"') ? '"' : "'";

  // Build all edits against one evolving buffer so multiple tokens accumulate.
  let content = target.content;
  let insertAt = end;
  for (const v of declaredMissing) {
    // Re-locate the closing bracket after each insertion.
    const reHead = new RegExp(head.source, 'g');
    const mm = reHead.exec(content);
    if (!mm) {
      skipped.push({
        ruleId: rule.id,
        token: v.token,
        reason: 'array-not-found',
        detail: `array \`${anchor}\` vanished mid-plan in ${target.path}`,
      });
      continue;
    }
    const open = mm.index + mm[0].length - 1;
    const scan = scanBalanced(content, open);

    // Decide the IMPORT before touching the array. An append that leaves the
    // token unbound compiles-fails, and a gate that goes green by breaking the
    // build is worse than one that refuses — so a token we cannot bind is
    // skipped with the reason, never half-written.
    const currentMembers = scan.elements
      .map((el) => elementToken(el.text))
      .filter((t): t is string => t !== undefined);
    const decision = quoted
      ? ({ kind: 'append-only' } as const) // string members bind nothing
      : decideImport(
          target.path,
          content,
          currentMembers,
          v.token,
          v.file,
          v.file ? files.find((f) => f.path === v.file)?.content : undefined,
        );
    if (decision.kind === 'refuse') {
      skipped.push({
        ruleId: rule.id,
        token: v.token,
        reason: 'needs-import',
        detail: decision.detail,
      });
      continue;
    }

    insertAt = scan.end;
    const last = scan.elements[scan.elements.length - 1];
    const indent = last ? indentOf(content, last.index) : '  ';
    const multiline = content.slice(open, insertAt).includes('\n');
    const rendered = quoted ? `${quoteChar}${v.token}${quoteChar}` : v.token;
    // Insert after the last non-whitespace character, and KEEP the whitespace
    // run that precedes the closing bracket — trimming it would drag `]` up
    // onto the last element's line and reformat code the user did not ask us
    // to touch.
    const beforeInsert = content.slice(0, insertAt).replace(/\s+$/, '');
    const cut = beforeInsert.length;
    const tail = content.slice(cut, insertAt);
    const needsComma = scan.elements.length > 0 && !beforeInsert.endsWith(',');
    const insert = multiline
      ? `${needsComma ? ',' : ''}\n${indent}${rendered},`
      : `${needsComma ? ', ' : ''}${rendered}`;
    content = content.slice(0, cut) + insert + tail + content.slice(insertAt);
    const arrayLine = lineOf(content, cut + insert.length);

    // Add the derived import LAST, so the array line number reported above is
    // computed before the insertion shifts it — the two edits are reported
    // against the file the reviewer will actually see.
    let importInsert: string | undefined;
    let importLine: number | undefined;
    if (decision.kind === 'derived') {
      const inserted = insertImportStatement(content, decision.statement);
      if (!inserted) {
        // Unreachable in practice (a template implies an import exists), but a
        // planner that silently dropped the import would reintroduce the bug.
        skipped.push({
          ruleId: rule.id,
          token: v.token,
          reason: 'needs-import',
          detail: `could not locate an import block in ${target.path} to extend`,
        });
        continue;
      }
      content = inserted.nextContent;
      importInsert = decision.statement;
      importLine = inserted.line;
    }

    edits.push({
      ruleId: rule.id,
      token: v.token,
      file: target.path,
      line: arrayLine,
      insert: insert.trim(),
      nextContent: content,
      ...(importInsert !== undefined ? { importInsert, importLine: importLine! } : {}),
    });
  }

  return { schema: WIRING_FIX_SCHEMA, edits, skipped };
}
