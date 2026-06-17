import { EContentType } from '../content/content-type.ts';
import { ECompressionStrategy } from '../result/compression-strategy.ts';
import type { ICompressionResult } from '../result/compression-result.ts';
import type { ICompressOptions } from '../result/compress-options.ts';
import { splitLines, queryTokens, queryOverlap, elide } from './line-utils.ts';
import { finalizeLossy, passthroughResult } from './finalize.ts';

const HEADER = /^#{1,6}\s/;
const LIST_ITEM = /^\s*(?:[-*+]\s|\d+\.\s)/;
const FENCE = /^\s*(?:```|~~~)/;
const TABLE_ROW = /^\s*\|/;

/**
 * Markdown-aware reduction that keeps a document's SKELETON — every header, the
 * first line of each section/paragraph, table rows, and a capped run of list
 * items — while thinning paragraph continuations and collapsing fenced code
 * block bodies. Structure is never dropped (headers always survive), so the
 * outline stays navigable; the full document is recoverable via CCR.
 *
 * Note: this runs only when an agent explicitly compresses markdown (via
 * `shrk compress` / `compress_context`). SharkCraft's own briefs/context are
 * never silently passed through it.
 */
export function compressMarkdown(text: string, opts: ICompressOptions = {}): ICompressionResult {
  const lines = splitLines(text);
  const minLines = opts.minLines ?? 12;
  if (lines.length < minLines) return passthroughResult(text, EContentType.Markdown);

  const tokens = queryTokens(opts.query);
  const maxListRun = opts.maxItems && opts.maxItems > 0 ? opts.maxItems : 8;
  const keep = new Set<number>();

  let inFence = false;
  let atParagraphStart = true; // first prose line of a paragraph is the lead
  let listRun = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (FENCE.test(line)) {
      keep.add(i); // keep both fences; interior is elided
      inFence = !inFence;
      atParagraphStart = false;
      listRun = 0;
      continue;
    }
    if (inFence) {
      if (tokens.length > 0 && queryOverlap(line, tokens) > 0) keep.add(i); // keep query-relevant code lines
      continue;
    }
    if (trimmed.length === 0) {
      atParagraphStart = true;
      listRun = 0;
      continue; // blank runs collapse via elide
    }
    if (HEADER.test(line)) {
      keep.add(i);
      atParagraphStart = true; // the line after a header is a section lead
      listRun = 0;
      continue;
    }
    if (TABLE_ROW.test(line)) {
      keep.add(i); // tables are already dense structure — keep rows
      atParagraphStart = false;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      listRun += 1;
      if (listRun <= maxListRun) keep.add(i);
      atParagraphStart = false;
      continue;
    }
    // Setext header: a text line underlined by a run of `=` (h1) or `-` (h2).
    // Keep the title AND its underline so the header survives intact.
    const underline = (lines[i + 1] ?? '').trim();
    if (/^=+$/.test(underline) || /^-+$/.test(underline)) {
      keep.add(i);
      keep.add(i + 1);
      atParagraphStart = true; // the line after a header is a section lead
      listRun = 0;
      i += 1; // consume the underline (the for-loop's increment skips it)
      continue;
    }
    // Prose: keep the lead line of a paragraph/section, drop continuations.
    if (atParagraphStart || (tokens.length > 0 && queryOverlap(line, tokens) > 0)) {
      keep.add(i);
    }
    atParagraphStart = false;
    listRun = 0;
  }

  const body = elide(lines, keep);
  return finalizeLossy({
    original: text,
    body,
    contentType: EContentType.Markdown,
    strategy: ECompressionStrategy.Markdown,
    opts,
    note: `full document: ${lines.length} lines`,
  });
}
