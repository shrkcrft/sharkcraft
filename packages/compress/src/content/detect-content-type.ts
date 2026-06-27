import { EContentType } from './content-type.ts';

const SEARCH_LINE = /^(?:[A-Za-z]:)?[^\s:]+:\d+:/;
// Compiler diagnostics that aren't `path:line:` shaped: tsc / MSVC
// `src/a.ts(10,5): error TS2322` and the `path(line):` family. These are search
// output, not source code — routing them to SourceCode mangled them.
const DIAGNOSTIC_LINE = /^(?:[A-Za-z]:)?[^\s:()]+\(\d+(?:,\d+)?\):\s/;
const DIFF_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
// YAML: `key:` / `key: value` mappings, `- ` sequence items, `---` doc markers.
const YAML_KEY = /^\s*[\w.-]+:(?:\s|$)/;
const YAML_LINE = /^\s*(?:[\w.-]+:(?:\s|$)|-\s|#|---\s*$|\.\.\.\s*$)/;
// A block-introducing key (`items:` with no inline value) followed by indented
// sequence items is unambiguously YAML — a Markdown list never has a bare
// `word:` line introducing indented bullets. Distinguishes list-heavy YAML
// (low key density) from a Markdown bullet list with an incidental `Note: x`.
const YAML_BLOCK_KEY = /^\s*[\w.-]+:\s*$/;
const YAML_INDENTED_SEQ = /^\s{2,}-\s/;
// Log levels must appear as a LINE PREFIX (optionally after a leading
// timestamp / bracket), not anywhere on the line — otherwise common code
// identifiers (`const ERROR = 500`, `enum { INFO, DEBUG }`) misroute to logs.
const LOG_MARKER =
  /^\s*(?:(?:\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+\]?|\S+\[\d+\]:)\s+)?\[?(?:ERROR|FATAL|FAIL(?:ED|URE)?|WARN(?:ING)?|INFO|DEBUG|NOTICE|TRACE)\b|^\S+\[\d+\]:\s|^\s*Traceback\b|^\s+at\s+\S+\s*\(|^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const MARKDOWN_MARKER = /^(?:#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|```|>\s|\|)/;
// Code signals: declaration keywords + structural/statement shapes that real
// code has but prose / markdown / INI / env / TOML / nginx do NOT (each new
// signal measures 0.00 on those). Built as a union of annotated sources.
const CODE_MARKER = new RegExp(
  [
    // declaration / punctuation (original)
    /\b(?:function|const|let|var|class|interface|enum|import|export|def|return|public|private|func|impl|struct|package|namespace)\b/,
    /=>/,
    /::/,
    /^\s*@\w+/,
    /^[\s{}()\[\];,]+$/,
    // typed return/param annotation: `): Foo {` / `): Foo =>` / `]: Bar =`
    /[)\]]\s*:\s*[A-Za-z_$][\w$.<>\[\], ]*\s*(?:=>|\{|=|$)/,
    // assignment statement terminated by `;` (rejects ==/=== via [^=]; needs trailing ;)
    /^\s*[A-Za-z_$][\w$.[\]]*\s*(?:\+|-|\*|\/|%|\?\?|\|\||&&|<<|>>|\||&|\^)?=\s*[^=].*;\s*$/,
    // member/method call AT LINE START: `obj.method(` (anchored so prose
    // "the system.config()" / "noun.verb(" embedded mid-sentence doesn't match)
    /^\s*[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/,
    // bare call statement AT LINE START ending in `;`: `doThing(args);` (anchored
    // so log lines like "Calling fetchUser(42);" don't match)
    /^\s*[A-Za-z_$][\w$]*\([^()]*\)\s*;\s*$/,
    // control-flow header: `if (x) {`, `for (...)`, `while/switch/catch (...)`
    /^\s*(?:if|for|while|switch|catch)\s*\(.*\)\s*\{?\s*$/,
  ]
    .map((r) => r.source)
    .join('|'),
);

function lineHitRatio(
  lines: readonly string[],
  test: RegExp | ((line: string) => boolean),
): number {
  if (lines.length === 0) return 0;
  const match = typeof test === 'function' ? test : (l: string): boolean => test.test(l);
  let hits = 0;
  for (const line of lines) if (match(line)) hits += 1;
  return hits / lines.length;
}

/**
 * Delimiter-separated values: a stable column count per line. Returns true when
 * one of `,`/`\t`/`;` yields the SAME count (≥1) on ≥90% of the non-blank lines
 * (≥2 of them) — a shape prose and config never have.
 */
function looksDelimited(nonBlank: readonly string[]): boolean {
  if (nonBlank.length < 2) return false;
  // `;` is excluded: semicolon-terminated prose/code lines have a stable count
  // of 1 and would masquerade as 2-column CSV. Real CSV/TSV uses `,` or tab.
  for (const delim of [',', '\t']) {
    const counts = nonBlank.map((l) => l.split(delim).length - 1);
    const freq = new Map<number, number>();
    for (const c of counts) freq.set(c, (freq.get(c) ?? 0) + 1);
    let modal = -1;
    let modalFreq = 0;
    for (const [c, f] of freq) {
      if (f > modalFreq || (f === modalFreq && c > modal)) {
        modal = c;
        modalFreq = f;
      }
    }
    // A real CSV/TSV has the same column count (≥2 columns ⇒ ≥1 delimiter) on
    // almost every line.
    if (modal >= 1 && modalFreq / nonBlank.length >= 0.9) return true;
  }
  return false;
}

/**
 * Classify a blob deterministically. Order is significant: JSON is checked
 * first (it round-trips cleanly through `JSON.parse`), then structural
 * formats (diff/search), then heuristic ones (log/code/markdown), with
 * plain text as the floor. Pure — same bytes in, same class out.
 */
export function detectContentType(text: string): EContentType {
  const trimmed = text.trim();
  if (trimmed.length === 0) return EContentType.PlainText;

  // 1. JSON — only when it actually parses, so we never mis-route prose that
  //    merely starts with a bracket.
  const first = trimmed[0];
  if (first === '[' || first === '{') {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return EContentType.JsonArray;
      if (parsed !== null && typeof parsed === 'object') return EContentType.Json;
      return EContentType.Json;
    } catch {
      // fall through — not valid JSON
    }
  }

  const lines = trimmed.split('\n');

  // 2. Git diff — a `diff --git` header or a clear hunk header set. Scan ALL
  //    `@@` lines (a leading malformed hunk must not defeat detection).
  if (
    /^diff --git /m.test(trimmed) ||
    (lines.some((l) => DIFF_HUNK.test(l)) &&
      /^--- /m.test(trimmed) &&
      /^\+\+\+ /m.test(trimmed))
  ) {
    return EContentType.GitDiff;
  }

  // 3. grep / ripgrep search output (`path:line:` prefix) OR compiler
  //    diagnostics (`path(line,col):`). Count either shape toward the ratio.
  if (lineHitRatio(lines, (l) => SEARCH_LINE.test(l) || DIAGNOSTIC_LINE.test(l)) >= 0.6) {
    return EContentType.SearchResults;
  }

  // 4. Build / test log (error / warn / timestamp markers dense enough).
  if (lineHitRatio(lines, LOG_MARKER) >= 0.25) return EContentType.BuildLog;

  // 5. Source code — keyword / structural density over non-blank lines OUTSIDE
  //    fenced code blocks (a markdown doc's ``` examples must not be counted as
  //    the doc's own code). A real source file has no fences, so its basis is
  //    unchanged. EOL punctuation alone must NOT count (prose/config ending in
  //    `;` is not code).
  // Only TOP-LEVEL fences (CommonMark allows ≤3 leading spaces) count — an
  // indented backtick line shown as a prose example must not toggle the fence
  // state and skew the balance check.
  const fenceRe = /^ {0,3}(?:```|~~~)/;
  // Only trust fence exclusion when fences are balanced. An odd (unterminated)
  // count — e.g. a stray ``` inside a source file's string/comment — would
  // otherwise flip `inFence` forever and exclude the rest of the file.
  const fenceCount = lines.reduce((n, l) => (fenceRe.test(l) ? n + 1 : n), 0);
  const excludeFences = fenceCount > 0 && fenceCount % 2 === 0;
  let inFence = false;
  const codeBasis: string[] = [];
  for (const l of lines) {
    if (excludeFences && fenceRe.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && l.trim().length > 0) codeBasis.push(l);
  }
  const codeRatio = codeBasis.length > 0 ? lineHitRatio(codeBasis, CODE_MARKER) : 0;
  if (codeRatio >= 0.45) return EContentType.SourceCode;

  const nonBlank = lines.filter((l) => l.trim().length > 0);

  // 5b. CSV / TSV — a stable column count per line (checked before YAML/markdown
  //     so a 2-column file isn't mistaken for `key: value` or a list).
  if (looksDelimited(nonBlank)) return EContentType.Csv;

  // 5c. YAML — ≥80% of non-blank lines are YAML-shaped AND either ≥30% are
  //     actual `key:` mappings (mapping-heavy config) OR there's a block-key →
  //     indented-sequence shape (list-heavy config). Both reject a plain
  //     Markdown bullet list. Checked before markdown, which would otherwise
  //     grab YAML's `- ` sequence items and lossily cap them.
  if (nonBlank.length >= 2) {
    const yamlShaped = lineHitRatio(nonBlank, YAML_LINE);
    const keyDensity = lineHitRatio(nonBlank, YAML_KEY);
    const blockSeq =
      nonBlank.some((l) => YAML_BLOCK_KEY.test(l)) && nonBlank.some((l) => YAML_INDENTED_SEQ.test(l));
    if (yamlShaped >= 0.8 && (keyDensity >= 0.3 || blockSeq)) return EContentType.Yaml;
  }

  // 6. Markdown — a marker-dense blob, OR a prose doc with ≥1 ATX header. The
  //    header rule is gated so a commented script (Python/shell `# …` lines, or
  //    a `#!`-shebang file) with low code-syntax density isn't mistaken for a doc.
  //    A single `# ` header is enough: ATX headers require a trailing space
  //    (`#{1,6}\s`), so a `#!`-shebang never counts, and the `looksLikeScript` +
  //    `codeRatio` guards already exclude commented scripts — without the
  //    single-header case, an ordinary prose doc (one title + paragraphs) fell
  //    through to PlainText and the markdown compressor was never applied.
  const headerCount = lines.reduce((n, l) => (/^#{1,6}\s/.test(l) ? n + 1 : n), 0);
  const looksLikeScript = (lines[0] ?? '').startsWith('#!');
  if (
    lineHitRatio(lines, MARKDOWN_MARKER) >= 0.3 ||
    (headerCount >= 1 && codeRatio < 0.15 && !looksLikeScript)
  ) {
    return EContentType.Markdown;
  }

  return EContentType.PlainText;
}
