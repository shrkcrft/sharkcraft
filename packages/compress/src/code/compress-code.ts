import { EContentType } from '../content/content-type.ts';
import { ECompressionStrategy } from '../result/compression-strategy.ts';
import type { ICompressionResult } from '../result/compression-result.ts';
import type { ICompressOptions } from '../result/compress-options.ts';
import { splitLines, elide, queryTokens, queryOverlap } from '../text/line-utils.ts';
import { finalizeLossy, passthroughResult } from '../text/finalize.ts';

/**
 * A code outliner done without a parser. It keeps a file's *shape* — imports,
 * type/interface/enum/class declarations and their members, and function/method
 * signatures — and elides function BODIES (the statements that don't change the
 * API). Reversible via CCR.
 *
 * The classifier is a comment/string/template/regex-aware scanner that tags
 * each `{` as `func` (a function/method/control body) or `decl`
 * (class/interface/enum/object), pushing onto a block-kind stack as it goes.
 * Two rules make it accurate: (1) a `{` preceded by a `)`+optional return type,
 * `=>`, or a control keyword is a func body; (2) once the enclosing block is a
 * func, every nested `{` stays func (so in-body object literals are elided
 * too). Lines inside a func block are dropped; everything else is kept. It is
 * intentionally approximate — it never rewrites code, only selects which lines
 * to show, and the original is always retrievable — so a mis-scan costs a few
 * extra/fewer kept lines, never corruption.
 */
type BlockKind = 'func' | 'decl';

interface IScanState {
  inBlockComment: boolean;
  inTemplate: boolean;
}

const DECL_OPEN =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|enum|namespace|module)\b/;
const PURE_CLOSE = /^[)}\]]+[;,]?$/;
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'case', 'throw',
]);
// Block-opening keywords whose body has no preceding `)` (so `closeParen` won't be set).
const CONTROL_BODY_WORDS = new Set(['do', 'else', 'try', 'finally']);

function isIdentChar(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$';
}

/** Advance past a string literal; returns the index after the closing quote (or EOL). */
function skipString(line: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return line.length;
}

/** Index after a regex literal, or -1 if it doesn't close on this line (then it
 *  wasn't a regex — a lone `/` to EOL is division/a path, not a literal). */
function skipRegex(line: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      i += 1;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '/') return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * Scan one line, updating the block-comment/template state AND pushing/popping
 * the block-kind stack per brace. Each `{` is classified at the moment it is
 * opened, using the enclosing kind plus the line-local token context.
 */
function applyLineToStack(line: string, state: IScanState, stack: BlockKind[]): void {
  let i = 0;
  let prevWord = '';
  let prevValue = false; // previous token can end an expression (ident/value/`)`/`]`/string/regex)
  let arrow = false; // just saw `=>`
  let closeParen = false; // saw `)` and only type-annotation tokens since
  let typeDepth = 0; // `<…>` / `[…]` nesting within a return-type annotation
  while (i < line.length) {
    if (state.inBlockComment) {
      if (line.startsWith('*/', i)) {
        state.inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (state.inTemplate) {
      const c = line[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        state.inTemplate = false;
        prevValue = true;
        prevWord = '';
        arrow = false;
      }
      i += 1;
      continue;
    }
    const c = line[i]!;
    if (c === ' ' || c === '\t') {
      i += 1;
      continue;
    }
    if (line.startsWith('//', i)) break;
    if (line.startsWith('/*', i)) {
      state.inBlockComment = true;
      i += 2;
      prevWord = '';
      arrow = false;
      continue;
    }
    if (c === '/') {
      const regexCtx = REGEX_KEYWORDS.has(prevWord) || !prevValue;
      const end = regexCtx ? skipRegex(line, i) : -1;
      if (end >= 0) {
        i = end;
        prevValue = true; // a regex literal is a value
      } else {
        i += 1;
        prevValue = false; // division operator (or unterminated `/`)
      }
      prevWord = '';
      arrow = false;
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipString(line, i, c);
      prevValue = true;
      closeParen = false;
      prevWord = '';
      arrow = false;
      continue;
    }
    if (c === '`') {
      state.inTemplate = true;
      i += 1;
      prevValue = true;
      closeParen = false;
      prevWord = '';
      arrow = false;
      continue;
    }
    if (c === '=' && line[i + 1] === '>') {
      arrow = true;
      prevValue = false;
      prevWord = '';
      i += 2;
      continue;
    }
    if (c === '{') {
      const top = stack.length > 0 ? stack[stack.length - 1]! : 'decl';
      const kind: BlockKind =
        top === 'func' || arrow || closeParen || CONTROL_BODY_WORDS.has(prevWord) ? 'func' : 'decl';
      stack.push(kind);
      prevValue = false;
      closeParen = false;
      typeDepth = 0;
      arrow = false;
      prevWord = '';
      i += 1;
      continue;
    }
    if (c === '}') {
      if (stack.length > 0) stack.pop();
      prevValue = false;
      closeParen = false;
      typeDepth = 0;
      arrow = false;
      prevWord = '';
      i += 1;
      continue;
    }
    if (c === ')') {
      closeParen = true;
      typeDepth = 0;
      prevValue = true;
      prevWord = '';
      arrow = false;
      i += 1;
      continue;
    }
    if (c === '[') {
      // In a return-type window (`): [a, b] {`) a `[` opens a TUPLE type — keep
      // closeParen and deepen; otherwise it's an array/index and ends the window.
      if (closeParen) typeDepth += 1;
      else closeParen = false;
      prevValue = false;
      prevWord = '';
      arrow = false;
      i += 1;
      continue;
    }
    if (c === ']') {
      if (closeParen && typeDepth > 0) typeDepth -= 1;
      prevValue = true;
      prevWord = '';
      arrow = false;
      i += 1;
      continue;
    }
    if (c === '(' || c === ';' || c === '=') {
      closeParen = false;
      typeDepth = 0;
      prevValue = false;
      prevWord = '';
      arrow = false;
      i += 1;
      continue;
    }
    // A `,` keeps closeParen ONLY inside a generic/tuple return type
    // (`): Record<string, Item> {` — typeDepth > 0). A top-level comma
    // (`resolve(): void, options: {`) ends the return-type window so the next
    // `{` is correctly an object/interface body, not a function body.
    if (c === ',') {
      if (!(closeParen && typeDepth > 0)) closeParen = false;
      prevValue = false;
      prevWord = '';
      arrow = false;
      i += 1;
      continue;
    }
    if (isIdentChar(c)) {
      let j = i;
      while (j < line.length && isIdentChar(line[j]!)) j += 1;
      prevWord = line.slice(i, j);
      prevValue = true; // identifiers / numbers are values (keyword check is separate)
      arrow = false;
      i = j;
      continue;
    }
    // Any other punctuation (`:` `.` `<` `>` `+` `-` …): leave closeParen so a
    // return-type annotation `): Foo<T> {` still reads as a func body. Track
    // `<…>` nesting inside that window so a comma there is a generic separator.
    if (closeParen) {
      // A `<` opens a generic only when it follows a type NAME (prevWord set);
      // a `<` after `)`/`]` (prevWord cleared) is a less-than comparison and
      // must NOT bump typeDepth (else a later `,` wrongly keeps closeParen).
      if (c === '<' && prevWord.length > 0) typeDepth += 1;
      else if (c === '>' && typeDepth > 0) typeDepth -= 1;
    }
    prevValue = false;
    prevWord = '';
    arrow = false;
    i += 1;
  }
}

export function compressCode(text: string, opts: ICompressOptions = {}): ICompressionResult {
  const lines = splitLines(text);
  const minLines = opts.minLines ?? 15;
  if (lines.length < minLines) return passthroughResult(text, EContentType.SourceCode);

  const tokens = queryTokens(opts.query);
  const state: IScanState = { inBlockComment: false, inTemplate: false };
  const stack: BlockKind[] = [];
  const keep = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();
    const enclosing: BlockKind = stack.length > 0 ? stack[stack.length - 1]! : 'decl';
    const inComment = state.inBlockComment;

    if (trimmed.length === 0) {
      // blanks elided
    } else if (inComment) {
      if (enclosing !== 'func') keep.add(i); // a top-level/decl block comment
    } else if (enclosing !== 'func') {
      keep.add(i); // top-level / class / interface / enum / object member
    } else if (DECL_OPEN.test(trimmed)) {
      keep.add(i); // a nested type declaration inside a body
    } else if (PURE_CLOSE.test(trimmed)) {
      keep.add(i); // structural closer
    } else if (tokens.length > 0 && queryOverlap(trimmed, tokens) > 0) {
      keep.add(i); // query-relevant body line
    }

    applyLineToStack(raw, state, stack);
  }

  const body = elide(lines, keep);
  return finalizeLossy({
    original: text,
    body,
    contentType: EContentType.SourceCode,
    strategy: ECompressionStrategy.Code,
    opts,
    note: `code outline: ${lines.length} lines (function bodies elided)`,
  });
}
