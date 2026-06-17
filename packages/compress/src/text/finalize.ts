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
    // Skip the trailing marker when the body already references THIS key inline
    // (e.g. compressLog's per-drop elision hints) — no need to repeat it. A
    // different inline key (e.g. a diff's per-section keys) still gets the
    // whole-blob marker appended. The marker carries only the key: the human
    // `note` is shipped separately in the result, so repeating it on the wire
    // would just cost tokens.
    compressed = body.includes(`<<ccr:${key}`) ? body : `${body}\n${formatCcrMarker(key)}`;
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
