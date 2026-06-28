/**
 * Extract inline `template:` string literals from source files so the template
 * policy surface can see markup that AOT/tsc treat as an opaque string. This is
 * a deterministic, framework-agnostic regex extraction (Angular/Vue/Lit-style
 * `template:` properties) — not a full TS parse. `templateUrl` is intentionally
 * NOT followed (the referenced `.html` file is scanned directly).
 */

export interface IExtractedTemplate {
  /** The template body (literal contents, quotes/backticks stripped). */
  readonly body: string;
  /** 1-based line in the source file where the body begins. */
  readonly startLine: number;
}

// `template:` followed by a single-quoted, double-quoted, or backtick literal.
// Backtick allows newlines (multi-line templates). The `(?:\\.|[^delim\\])*`
// form is escape-aware, so an escaped same-delimiter quote (`\"` inside `"…"`)
// or an escaped backtick does NOT truncate the captured literal (which would
// silently drop violations after it). A nested backtick inside a `${…}`
// interpolation is still not handled (rare).
const TEMPLATE_RE = /\btemplate\s*:\s*(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;

function lineOf(content: string, index: number): number {
  let line = 1;
  const end = Math.min(index, content.length);
  for (let i = 0; i < end; i += 1) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

export function extractInlineTemplates(content: string): IExtractedTemplate[] {
  const out: IExtractedTemplate[] = [];
  TEMPLATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_RE.exec(content)) !== null) {
    if (m.index === TEMPLATE_RE.lastIndex) TEMPLATE_RE.lastIndex += 1; // zero-width guard
    const literal = m[1];
    if (!literal) continue;
    const body = literal.slice(1, -1);
    if (body.length === 0) continue;
    // Index of the opening delimiter, then +1 for the first body char.
    const literalStart = m.index + m[0].length - literal.length;
    out.push({ body, startLine: lineOf(content, literalStart + 1) });
  }
  return out;
}
