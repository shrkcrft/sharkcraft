import { EContentType } from '../content/content-type.ts';
import { ECompressionStrategy } from '../result/compression-strategy.ts';
import type { ICompressionResult } from '../result/compression-result.ts';
import type { ICompressOptions } from '../result/compress-options.ts';
import { splitLines, dedupeKey, queryTokens } from './line-utils.ts';
import { finalizeLossy, passthroughResult } from './finalize.ts';
import { mineLogTemplates } from './log-template.ts';
import { bm25Scores } from '../relevance/bm25.ts';
import { formatCcrMarker } from '../ccr/ccr-marker.ts';

const ERROR_RE = /\b(?:ERROR|FATAL|FAIL(?:ED|URE)?|EXCEPTION|panic)\b/i;
// High-signal failure lines that often carry NONE of the ERROR/FATAL/FAIL
// keywords yet ARE the root cause: native crashes (segfault, core dump, bus
// error), the OOM killer, linker errors, fatal POSIX signals, and assertion
// failures. Without this they get elided when they aren't an anchor. Treated
// exactly like an error line (kept, with the preceding line and any following
// trace). Keeping an occasional benign match costs one extra line — far cheaper
// than dropping the actual cause.
const FATAL_SIGNAL_RE =
  /\b(?:segmentation fault|segfault|core dumped|bus error|out of memory|oom[- ]?kill(?:er|ed)?|killed process|undefined reference to|undefined symbol|symbol\(s\) not found|cannot find -l|assertion (?:failed|.*failed)|SIG(?:SEGV|ABRT|KILL|BUS|FPE|ILL)\b|signal \d+|Aborted)\b/i;
const WARN_RE = /\bWARN(?:ING)?\b/i;
const SUMMARY_RE =
  /\b(?:\d+ (?:passed|failed|error|errors|skipped)|Tests:|Test Suites:|collected \d+|BUILD (?:SUCCESS|FAIL(?:ED|URE)?)|Summary:)\b|^[✓✗×]/;
const STACK_RE = /^\s+(?:at\s+\S+|File ".*", line \d+)/;
// Start of a multi-frame trace region.
const TRACEBACK_START = /^\s*Traceback\b|^\s*Caused by:|^\s*Exception in thread\b/;
// The punchline of a trace: `ValueError: boom`, `java.lang.NullPointerException: null`.
const EXCEPTION_SUMMARY = /^[\w.$]*(?:Error|Exception|Warning|Panic)\b.*:/;

/**
 * Reduce build / test / runtime logs to their signal: errors and their FULL
 * multi-frame stack traces, the exception punchline, de-duplicated warnings,
 * summary lines, and first/last anchors. The rest is elided. When a hard
 * `maxItems` cap applies, lines are dropped by PRIORITY (summaries > errors >
 * anchors > other), never by position — so the closing summary always survives.
 * Deterministic and order-preserving; the full log is recoverable via CCR.
 */
export function compressLog(text: string, opts: ICompressOptions = {}): ICompressionResult {
  const lines = splitLines(text);
  const minLines = opts.minLines ?? 12;
  if (lines.length < minLines) return passthroughResult(text, EContentType.BuildLog);

  const tokens = queryTokens(opts.query);
  // P3.2: BM25 relevance for the query (idf-weighted, length-normalized, ID-term
  // boosted). Computed only when a query is present, so the no-query path is
  // unchanged.
  const relScores = opts.query ? bm25Scores(opts.query, lines) : null;
  const keep = new Set<number>();
  const errorIdx = new Set<number>();
  const summaryIdx = new Set<number>();
  const anchorIdx = new Set<number>();
  const queryIdx = new Set<number>();
  const seenWarn = new Set<string>();
  let stackActive = false;
  let inFrameSource = false; // we are inside a frame's indented source block

  for (const i of [0, 1, lines.length - 2, lines.length - 1]) {
    if (i >= 0 && i < lines.length) {
      keep.add(i);
      anchorIdx.add(i);
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const isSummary = SUMMARY_RE.test(line);
    // Errors / trace starts are handled FIRST so trace control flow is correct,
    // but a line that is ALSO a summary (e.g. "Tests: 1 failed" — "failed"
    // matches ERROR_RE) is still tagged into summaryIdx so the cap ranks it as
    // a summary. This keeps multi-frame traces intact while letting the closing
    // result survive a tight cap.
    if (
      ERROR_RE.test(line) ||
      FATAL_SIGNAL_RE.test(line) ||
      TRACEBACK_START.test(line) ||
      EXCEPTION_SUMMARY.test(line)
    ) {
      keep.add(i);
      errorIdx.add(i);
      if (isSummary) summaryIdx.add(i);
      if (i - 1 >= 0) keep.add(i - 1);
      stackActive = true;
      inFrameSource = false;
      continue;
    }
    if (stackActive) {
      if (line.trim().length === 0) {
        stackActive = false; // a blank line ends the trace region
        inFrameSource = false;
      } else if (STACK_RE.test(line)) {
        keep.add(i); // a real stack frame (`at …` / `File …`)
        errorIdx.add(i);
        inFrameSource = true;
        continue;
      } else if (inFrameSource && /^\s/.test(line)) {
        keep.add(i); // indented source line(s) under a frame — keep the whole block
        errorIdx.add(i);
        continue;
      } else if (/^\s/.test(line)) {
        // Indented, but NOT after a frame (e.g. a captured-stdout / locals dump
        // straight after the error) — drop it, but stay in the trace region.
        continue;
      } else {
        stackActive = false; // a dedented non-trace line ends the region — re-check it below
        inFrameSource = false;
      }
    }
    if (isSummary) {
      keep.add(i);
      summaryIdx.add(i);
      continue;
    }
    if (WARN_RE.test(line)) {
      const k = dedupeKey(line);
      if (!seenWarn.has(k)) {
        seenWarn.add(k);
        keep.add(i);
      }
      continue;
    }
    if (relScores && relScores[i]! > 0) {
      keep.add(i);
      queryIdx.add(i);
    }
  }

  // Hard cap: force-keep the CLOSING summary (the last summary line) so the
  // test/build result always survives, then fill the rest errors-first, then
  // other summaries, then anchors, then the remainder. This keeps both the real
  // error and the closing result even when summary-shaped noise is abundant.
  if (opts.maxItems && keep.size > opts.maxItems) {
    const cap = opts.maxItems;
    const chosen = new Set<number>();
    const summaries = [...summaryIdx].sort((a, b) => a - b);
    if (summaries.length > 0) chosen.add(summaries[summaries.length - 1]!);
    const rank = (i: number): number =>
      errorIdx.has(i) ? 0 : summaryIdx.has(i) ? 1 : queryIdx.has(i) ? 2 : anchorIdx.has(i) ? 3 : 4;
    // Within a tier, the more query-relevant line (higher BM25) wins; rel is 0
    // for non-query lines, so this is a no-op tiebreak without a query.
    const rel = (i: number): number => (relScores ? relScores[i]! : 0);
    const rest = [...keep]
      .filter((i) => !chosen.has(i))
      .sort((a, b) => rank(a) - rank(b) || rel(b) - rel(a) || a - b);
    for (const i of rest) {
      if (chosen.size >= cap) break;
      chosen.add(i);
    }
    keep.clear();
    for (const i of chosen) keep.add(i);
  }

  // P2.2: collapse repetitive runs of KEPT lines (summary/query spam) into
  // lossless template blocks. Mining only the *kept* runs is the key: lines the
  // selector drops stay dropped (a one-line `… omitted …` always beats keeping
  // a template block), so noise logs never regress — only signal the agent
  // actually sees gets the lossless columnar collapse.
  //
  // P4.5: when a CCR store is present, cache the original up front and stamp its
  // key into each elision hint, so the agent can tell a root cause was dropped
  // RIGHT THERE and retrieve it. finalizeLossy reuses this same key (and skips
  // its own trailing marker since the body already carries it).
  const ccrKey = opts.store ? opts.store.put(text) : undefined;
  const body = elideWithTemplates(lines, keep, ccrKey);
  return finalizeLossy({
    original: text,
    body,
    contentType: EContentType.BuildLog,
    strategy: ECompressionStrategy.Log,
    opts,
    note: `full log: ${lines.length} lines`,
  });
}

/**
 * Like {@link elide}, but each maximal run of consecutive KEPT lines is passed
 * through {@link mineLogTemplates} so repetitive kept lines collapse to a
 * lossless template block. Each dropped run becomes a single hint; when
 * `ccrKey` is given the hint carries `→ <<ccr:KEY>>` so the elided detail is
 * retrievable in place (P4.5).
 */
function elideWithTemplates(
  lines: readonly string[],
  keep: ReadonlySet<number>,
  ccrKey?: string,
): string {
  const out: string[] = [];
  let dropped = 0;
  const flush = (): void => {
    if (dropped > 0) {
      const hint = ccrKey ? ` → ${formatCcrMarker(ccrKey)}` : '';
      out.push(`… ${dropped} line${dropped === 1 ? '' : 's'} omitted${hint}`);
      dropped = 0;
    }
  };
  let i = 0;
  while (i < lines.length) {
    if (!keep.has(i)) {
      dropped += 1;
      i += 1;
      continue;
    }
    flush();
    let j = i;
    while (j < lines.length && keep.has(j)) j += 1;
    out.push(...mineLogTemplates(lines.slice(i, j)).lines);
    i = j;
  }
  flush();
  return out.join('\n');
}
