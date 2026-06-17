import { EContentType } from '../content/content-type.ts';
import { ECompressionStrategy } from '../result/compression-strategy.ts';
import type { ICompressionResult } from '../result/compression-result.ts';
import type { ICompressOptions } from '../result/compress-options.ts';
import { splitLines, elide } from './line-utils.ts';
import { finalizeLossy, passthroughResult } from './finalize.ts';
import { computeOptimalK } from '../table/adaptive-size.ts';
import { bm25Scores } from '../relevance/bm25.ts';

// Allow an optional Windows drive prefix (`C:`) before the path, so rg/grep
// output captured on Windows still parses (the drive colon isn't the separator).
const SEARCH_LINE = /^((?:[A-Za-z]:)?[^\s:]+):(\d+):(.*)$/;
const PRIORITY_RE = /\b(?:ERROR|FAIL|TODO|FIXME|BUG|throw|panic|deprecated)\b/i;

interface IMatch {
  index: number;
  file: string;
  body: string;
  score: number;
}

/**
 * Reduce grep / ripgrep `file:line:` output to the highest-signal matches:
 * the first hit in every file is always kept (so no file silently vanishes),
 * then the top matches per file by query overlap and priority keywords. Lines
 * that aren't matches (headers, blanks) are preserved as structure. Dropped
 * matches are elided; the full output is recoverable via CCR.
 */
export function compressSearch(text: string, opts: ICompressOptions = {}): ICompressionResult {
  const lines = splitLines(text);
  const matches: IMatch[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = SEARCH_LINE.exec(lines[i] ?? '');
    if (!m) continue;
    const file = m[1] ?? '';
    const body = m[3] ?? '';
    matches.push({ index: i, file, body, score: PRIORITY_RE.test(body) ? 0.5 : 0 });
  }
  if (matches.length < 2) return passthroughResult(text, EContentType.SearchResults);

  // P3.2: bias retained matches by BM25 relevance to the query (idf-weighted,
  // length-normalized, ID-term boosted). No query → all zeros, so ranking falls
  // back to the priority-keyword bonus exactly as before.
  if (opts.query) {
    const rel = bm25Scores(opts.query, matches.map((m) => m.body));
    for (let k = 0; k < matches.length; k += 1) matches[k]!.score += rel[k]!;
  }

  // P3.1: with no explicit cap, size the per-file keep from how much unique
  // information the match bodies carry — fewer on redundant hits, up to 8 on
  // diverse ones. An explicit `maxItems` always wins.
  const perFile =
    opts.maxItems ?? computeOptimalK(matches.map((m) => m.body), { min: 2, max: 8 });
  const byFile = new Map<string, IMatch[]>();
  for (const m of matches) {
    const list = byFile.get(m.file) ?? [];
    list.push(m);
    byFile.set(m.file, list);
  }

  const keep = new Set<number>();
  // Keep every non-match line (structural): headers, separators, blanks.
  const matchIdx = new Set(matches.map((m) => m.index));
  for (let i = 0; i < lines.length; i += 1) if (!matchIdx.has(i)) keep.add(i);

  for (const list of byFile.values()) {
    // Always keep the first match in the file (so no file silently vanishes),
    // then fill the per-file budget with the highest-scoring REMAINING matches.
    // Excluding `first` from the ranked fill keeps the total at exactly `perFile`
    // rather than `perFile + 1` when the first match isn't itself top-ranked.
    const first = list[0]!;
    keep.add(first.index);
    const ranked = [...list]
      .filter((m) => m.index !== first.index)
      .sort((a, b) => (b.score - a.score) || (a.index - b.index))
      .slice(0, Math.max(0, perFile - 1));
    for (const m of ranked) keep.add(m.index);
  }

  const body = elide(lines, keep);
  return finalizeLossy({
    original: text,
    body,
    contentType: EContentType.SearchResults,
    strategy: ECompressionStrategy.Search,
    opts,
    note: `full results: ${matches.length} matches in ${byFile.size} files`,
  });
}
