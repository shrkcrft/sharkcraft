import type { EContentType } from '../content/content-type.ts';
import { ECompressionStrategy } from '../result/compression-strategy.ts';
import type { ICompressionResult } from '../result/compression-result.ts';
import type { ICompressOptions } from '../result/compress-options.ts';
import { measureSavings } from '../tokens/estimate-tokens.ts';
import { formatCcrMarker } from '../ccr/ccr-marker.ts';

/** A no-op result: the input wasn't worth compressing. */
export function passthroughResult(
  original: string,
  contentType: EContentType,
  note = 'below threshold — no reduction',
): ICompressionResult {
  return {
    compressed: original,
    contentType,
    strategy: ECompressionStrategy.Passthrough,
    savings: measureSavings(original, original, contentType),
    lossy: false,
    note,
  };
}

/**
 * Wrap a lossy compressor's body into a result: cache the original (when a
 * store is given) and append a CCR retrieval marker, then verify the pass
 * actually saved tokens — if it didn't, fall back to passthrough so a
 * compressor is never a net loss.
 */
export function finalizeLossy(params: {
  original: string;
  body: string;
  contentType: EContentType;
  strategy: ECompressionStrategy;
  opts: ICompressOptions;
  note: string;
}): ICompressionResult {
  const { original, body, contentType, strategy, opts, note } = params;
  // Compare modulo `\r`: the compressors run on LF-normalized lines, so a CRLF
  // input with NO elision yields a body that differs only by line endings —
  // that is not a real reduction and must passthrough the original untouched.
  const reduced = body.replace(/\r/g, '') !== original.replace(/\r/g, '');
  if (!reduced) return passthroughResult(original, contentType);
  let compressed = body;
  let key: string | undefined;
  if (opts.store) {
    key = opts.store.put(original);
    // Make inline `… N lines omitted` placeholders self-describing: a reader
    // who only sees a clipped middle of the output otherwise can't tell the
    // dropped detail is retrievable. Annotate each with the recovery key.
    compressed = annotateElisionMarkers(body, key);
    // Skip the trailing marker when the body already references THIS key inline
    // (e.g. compressLog's per-drop elision hints) — no need to repeat it. A
    // different inline key (e.g. a diff's per-section keys) still gets the
    // whole-blob marker appended. The marker carries only the key: the human
    // `note` is shipped separately in the result, so repeating it on the wire
    // would just cost tokens.
    compressed = compressed.includes(`<<ccr:${key}`)
      ? compressed
      : `${compressed}\n${formatCcrMarker(key)}`;
  }
  const savings = measureSavings(original, compressed, contentType);
  if (savings.after >= savings.before) {
    return passthroughResult(original, contentType);
  }
  return {
    compressed,
    contentType,
    strategy,
    savings,
    lossy: true,
    ...(key ? { ccrKey: key } : {}),
    note,
  };
}

/**
 * Append the recovery key to each `… N line(s) omitted` placeholder produced by
 * {@link elide} (used by the markdown/search/lines compressors), so a clipped
 * view still advertises that the dropped detail is retrievable via `shrk expand`.
 * Deterministic; leaves bodies without such markers (logs/diffs use their own
 * keyed hints) untouched.
 */
function annotateElisionMarkers(body: string, key: string): string {
  // Match ONLY a standalone-line `… N lines omitted` (what elide() emits, on its
  // own line). The lookahead for end-of-line excludes compressLog's inline-keyed
  // markers (`… N lines omitted → <<ccr:KEY>>`), which already carry the key.
  return body.replace(
    /(… \d+ lines? omitted)(?=\n|$)/g,
    (marker) => `${marker} (shrk expand ${key})`,
  );
}
