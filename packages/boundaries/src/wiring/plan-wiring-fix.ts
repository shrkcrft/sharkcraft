import type { IWiringRule, IWiringSource } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { escapeRegex, scanBalanced } from '../extract/scan-literals.ts';
import { registeredSources, type IWiringViolation } from './evaluate-wiring.ts';
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
  | 'token-shape-mismatch';

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
    edits.push({
      ruleId: rule.id,
      token: v.token,
      file: target.path,
      line: lineOf(content, cut + insert.length),
      insert: insert.trim(),
      nextContent: content,
    });
  }

  return { schema: WIRING_FIX_SCHEMA, edits, skipped };
}
