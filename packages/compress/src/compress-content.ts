import { EContentType } from './content/content-type.ts';
import { detectContentType } from './content/detect-content-type.ts';
import { segmentContent, isRichSegmentType } from './content/segment.ts';
import type { ICompressionResult } from './result/compression-result.ts';
import type { ICompressOptions } from './result/compress-options.ts';
import { ECompressionStrategy } from './result/compression-strategy.ts';
import { measureSavings } from './tokens/estimate-tokens.ts';
import { passthroughResult } from './text/finalize.ts';
import { compressJson } from './json/compress-json.ts';
import { compressLog } from './text/compress-log.ts';
import { compressSearch } from './text/compress-search.ts';
import { compressDiff } from './text/compress-diff.ts';
import { compressLines } from './text/compress-lines.ts';
import { compressMarkdown } from './text/compress-markdown.ts';
import { compressCode } from './code/compress-code.ts';

/**
 * Route a blob to the right deterministic compressor and return the result.
 * This is the one entry point the `shrk compress` CLI and the
 * `compress_context` MCP tool call. Content type is auto-detected unless
 * forced via `opts.contentType`. Pure — no model, no network; the same bytes
 * and options always yield the same output.
 */
export function compressContent(text: string, opts: ICompressOptions = {}): ICompressionResult {
  const result = routeCompressContent(text, opts);
  // `lossless` is a hard guard applied at the single entry point so it catches
  // every lossy path (text elision, JSON row-sampling, mixed) uniformly: a
  // result that drops information is replaced by the verbatim original.
  if (opts.lossless && result.lossy) {
    return passthroughResult(text, result.contentType, 'lossless requested — lossy reduction skipped');
  }
  return result;
}

function routeCompressContent(text: string, opts: ICompressOptions): ICompressionResult {
  const type = opts.contentType ?? detectContentType(text);
  switch (type) {
    case EContentType.JsonArray:
    case EContentType.Json:
      return compressJson(text, opts);
    case EContentType.GitDiff:
      return compressDiff(text, opts);
    case EContentType.SearchResults:
      return compressSearch(text, opts);
    case EContentType.BuildLog:
      return compressLog(text, opts);
    case EContentType.SourceCode:
      return compressCode(text, opts);
    case EContentType.Markdown:
      return compressMarkdown(text, opts);
    case EContentType.PlainText:
    default:
      // P4.3: a blob that didn't match one clean type may still be a MIX of
      // types (prose + a JSON block + a stack trace). Segment and compress each
      // run with its own strategy. Only the catch-all PlainText path tries this,
      // so every single-type route above is byte-identical to before.
      if (!opts.contentType) {
        const mixed = compressMixed(text, opts);
        if (mixed) return mixed;
      }
      return compressLines(text, type, opts);
  }
}

/**
 * Compress a mixed blob by segmenting it and routing each run to its own
 * compressor, then reassembling. Returns null when the blob is effectively
 * single-type (≤1 rich segment) or the segmented result doesn't beat plain
 * line dedup — so the caller falls back to {@link compressLines}.
 */
function compressMixed(text: string, opts: ICompressOptions): ICompressionResult | null {
  const segments = segmentContent(text);
  if (segments.length < 2 || !segments.some((s) => isRichSegmentType(s.type))) return null;

  let anyLossy = false;
  const parts = segments.map((seg) => {
    const r = compressContent(seg.text, { ...opts, contentType: seg.type });
    if (r.lossy) anyLossy = true;
    return r.compressed;
  });
  const reassembled = parts.join('\n');
  const savings = measureSavings(text, reassembled, EContentType.PlainText);
  if (savings.after >= savings.before) return null; // line dedup may still win

  return {
    compressed: reassembled,
    contentType: EContentType.PlainText,
    strategy: ECompressionStrategy.Mixed,
    savings,
    lossy: anyLossy,
    note: `mixed: ${segments.length} segments (${segments.map((s) => s.type).join(', ')})`,
  };
}
