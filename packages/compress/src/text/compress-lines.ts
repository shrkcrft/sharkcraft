import { EContentType } from '../content/content-type.ts';
import { ECompressionStrategy } from '../result/compression-strategy.ts';
import type { ICompressionResult } from '../result/compression-result.ts';
import type { ICompressOptions } from '../result/compress-options.ts';
import { splitLines, elide } from './line-utils.ts';
import { finalizeLossy, passthroughResult } from './finalize.ts';

/**
 * Conservative generic reduction for prose / plain text: drop exact-duplicate
 * non-blank lines (keeping the first occurrence) and collapse runs of blank
 * lines. Prose with little repetition passes through unchanged — which is the
 * honest outcome; structured content should route to a typed compressor
 * instead. Recoverable via CCR.
 */
export function compressLines(
  text: string,
  contentType: EContentType = EContentType.PlainText,
  opts: ICompressOptions = {},
): ICompressionResult {
  const lines = splitLines(text);
  const minLines = opts.minLines ?? 8;
  if (lines.length < minLines) return passthroughResult(text, contentType);

  const keep = new Set<number>();
  const seen = new Set<string>();
  let prevBlank = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const blank = line.trim().length === 0;
    if (blank) {
      if (!prevBlank) keep.add(i);
      prevBlank = true;
      continue;
    }
    prevBlank = false;
    if (seen.has(line)) continue; // exact duplicate — drop
    seen.add(line);
    keep.add(i);
  }

  const body = elide(lines, keep);
  return finalizeLossy({
    original: text,
    body,
    contentType,
    strategy: ECompressionStrategy.Lines,
    opts,
    note: `full text: ${lines.length} lines`,
  });
}
