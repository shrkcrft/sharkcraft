/**
 * Lexical primitives shared by every extractor and by the policy zone
 * classifier: skip a string literal, skip a comment, find the line of an
 * offset, split a balanced bracket block into its top-level elements.
 *
 * These are deliberately a LEXER, not a parser. The engine must read `.ts`,
 * `.kt`, `.swift`, `.scss`, `.json` and inline template strings with one code
 * path and no per-language toolchain; a lexer is the largest thing that stays
 * honest across all of them. The documented limits: a regex literal whose body
 * contains `//` or `/*` is read as a comment, and a language whose string or
 * comment syntax differs from the C/JS family (e.g. `#` comments) is scanned as
 * plain code.
 */

/** Index of the closing quote of the string starting at `start` (handles escapes). */
export function skipString(content: string, start: number): number {
  const quote = content[start];
  for (let i = start + 1; i < content.length; i += 1) {
    if (content[i] === '\\') {
      i += 1;
      continue;
    }
    if (content[i] === quote) return i;
  }
  return content.length - 1;
}

/**
 * If a comment starts at `start`, the index of its LAST character; otherwise
 * `-1`. Handles `// … \n` and `/* … *\/`.
 */
export function skipComment(content: string, start: number): number {
  if (content[start] !== '/') return -1;
  const next = content[start + 1];
  if (next === '/') {
    const nl = content.indexOf('\n', start + 2);
    return nl === -1 ? content.length - 1 : nl - 1;
  }
  if (next === '*') {
    const end = content.indexOf('*/', start + 2);
    return end === -1 ? content.length - 1 : end + 1;
  }
  return -1;
}

/** 1-based line number of a character offset. */
export function lineOf(content: string, index: number): number {
  let line = 1;
  const end = Math.min(index, content.length);
  for (let i = 0; i < end; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

/** Escape a literal string for embedding in a RegExp source. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One top-level element of a balanced bracket block, with its source offset. */
export interface IBracketElement {
  readonly text: string;
  readonly index: number;
}

/** Result of {@link scanBalanced}: the elements and the closing bracket's offset. */
export interface IBracketScan {
  readonly elements: readonly IBracketElement[];
  readonly end: number;
}

/**
 * Advance past whitespace AND leading comments, returning the offset of the
 * element's first real character.
 *
 * A registry array is exactly where authors leave section comments
 * (`// spec read-only tools.`), and treating one as the element's text drops
 * the entry that follows it — a false "not registered" that is worse than no
 * rule at all. Skipping the trivia also puts the reported line on the token
 * rather than on its comment.
 */
function skipLeadingTrivia(content: string, start: number, end: number): number {
  let i = start;
  while (i < end) {
    const c = content[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    const commentEnd = skipComment(content, i);
    if (commentEnd >= 0) {
      i = commentEnd + 1;
      continue;
    }
    break;
  }
  return i;
}

function pushElement(
  elements: IBracketElement[],
  content: string,
  start: number,
  end: number,
): void {
  const from = skipLeadingTrivia(content, start, end);
  const text = content.slice(from, end).trim();
  if (text === '') return;
  elements.push({ text, index: from });
}

/**
 * Scan a `[ … ]` / `( … )` / `{ … }` block from its OPENING bracket, splitting
 * the top-level (depth-1) comma-separated elements. String- and comment-aware,
 * so commas and brackets inside nested literals, strings, or comments never
 * mis-split. An unterminated block yields everything to end-of-content.
 */
export function scanBalanced(content: string, openIndex: number): IBracketScan {
  const elements: IBracketElement[] = [];
  let depth = 0;
  let elemStart = openIndex + 1;
  for (let i = openIndex; i < content.length; i += 1) {
    const c = content[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(content, i);
      continue;
    }
    if (c === '/') {
      const commentEnd = skipComment(content, i);
      if (commentEnd >= 0) {
        i = commentEnd;
        continue;
      }
    }
    if (c === '[' || c === '(' || c === '{') {
      depth += 1;
    } else if (c === ']' || c === ')' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        pushElement(elements, content, elemStart, i);
        return { elements, end: i };
      }
    } else if (c === ',' && depth === 1) {
      pushElement(elements, content, elemStart, i);
      elemStart = i + 1;
    }
  }
  pushElement(elements, content, elemStart, content.length);
  return { elements, end: content.length - 1 };
}

/**
 * The id carried by one element: the contents of a leading quoted string, or
 * the leading identifier. `undefined` when the element starts with neither
 * (a spread, a number, a nested literal).
 */
export function elementToken(text: string): string | undefined {
  const first = text[0];
  if (first === '"' || first === "'" || first === '`') {
    const close = text.indexOf(first, 1);
    return close > 0 ? text.slice(1, close) : undefined;
  }
  const m = /^[A-Za-z_$][\w$]*/.exec(text);
  return m ? m[0] : undefined;
}

/**
 * The VALUE side of a `key: value` / `member = value` element: the contents of
 * a quoted string, or a bare numeric/identifier token. `undefined` when the
 * element carries no assignment or the value is a nested construct.
 */
export function elementValue(text: string): string | undefined {
  // Find the first top-level `:` or `=` (skipping strings and `=>`).
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if (c === '=' && text[i + 1] === '>') return undefined;
    if (c === ':' || c === '=') {
      const rhs = text.slice(i + 1).trim();
      if (rhs === '') return undefined;
      const q = rhs[0];
      if (q === '"' || q === "'" || q === '`') {
        const close = rhs.indexOf(q, 1);
        return close > 0 ? rhs.slice(1, close) : undefined;
      }
      const m = /^[\w$.-]+/.exec(rhs);
      return m ? m[0] : undefined;
    }
  }
  return undefined;
}
