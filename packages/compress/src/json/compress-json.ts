import { EContentType } from '../content/content-type.ts';
import { ECompressionStrategy } from '../result/compression-strategy.ts';
import type { ICompressionResult } from '../result/compression-result.ts';
import type { ICompressOptions } from '../result/compress-options.ts';
import { estimateTokens, measureSavings } from '../tokens/estimate-tokens.ts';
import { compactArrayToColumnar } from '../table/columnar-json.ts';
import { compactObjectMap } from '../table/object-map.ts';
import { sampleObjectArray } from '../table/sample-object-array.ts';
import { compressLines } from '../text/compress-lines.ts';
import { finalizeLossy, passthroughResult } from '../text/finalize.ts';

const NUMBER_TOKEN = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/**
 * Blank out the contents of every JSON string (object keys AND string values),
 * leaving structural punctuation, whitespace, and bare literals in place. After
 * this, the only digit runs left are genuine JSON *number* literals — a digit
 * run that lived inside a string (a record id, a git SHA, a numeric-looking
 * code) is gone. Quote handling respects backslash escapes so `"a\""` stays a
 * single string.
 */
function stripJsonStrings(text: string): string {
  const out: string[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') {
        i++; // skip the escaped char too
        continue;
      }
      if (ch === '"') inString = false;
      continue; // drop the string's contents
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

/**
 * True if any JSON-number *literal* in the text would NOT survive a
 * parse→serialize round trip — it overflows to Infinity (→ `null`), or carries
 * more than ~15 significant digits (precision loss for big integers AND
 * decimal-split floats like `90071992547409.93`). Counting significant mantissa
 * digits (rather than a contiguous-digit run) is what catches floats whose
 * digits straddle the dot. Only actual number literals are inspected — digit
 * runs inside string values / keys are stripped first, because a numeric-looking
 * STRING round-trips verbatim and is never at risk (so a list of records with
 * id-like string fields still compacts losslessly). Sound: when true we keep the
 * original bytes instead of a false "lossless".
 */
function hasRiskyNumber(text: string): boolean {
  const scannable = stripJsonStrings(text);
  for (const match of scannable.matchAll(NUMBER_TOKEN)) {
    const token = match[0];
    const n = Number(token);
    if (!Number.isFinite(n)) return true; // overflow → Infinity → null
    if (n === 0 && /[1-9]/.test(token)) return true; // underflow: nonzero literal → 0
    const sig = token.replace(/[eE].*$/, '').replace(/[-.]/g, '').replace(/^0+/, '');
    if (sig.length > 15) return true;
  }
  return false;
}

/**
 * Compress JSON losslessly. A homogeneous object array becomes a *columnar*
 * encoding — the shared schema is hoisted once and each row carries only
 * values — which is still valid JSON and exactly reconstructable via
 * `expandColumnar` (absent keys, nulls and empty strings are all preserved
 * distinctly). Anything else is minified. No detail is dropped, so no CCR
 * marker is needed. Falls back to line dedup if the text isn't valid JSON, and
 * passes through untouched when re-serialization would lose precision (integers
 * beyond 2^53), so the lossless guarantee always holds.
 *
 * (The dense text table from `renderCompactJson` is *not* used here: it
 * renders null / "" / absent identically, so it cannot carry the lossless
 * guarantee this function advertises.)
 */
export function compressJson(text: string, opts: ICompressOptions = {}): ICompressionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return compressLines(text, EContentType.PlainText, opts);
  }
  const forced =
    opts.contentType === EContentType.Json || opts.contentType === EContentType.JsonArray
      ? opts.contentType
      : undefined;
  const contentType = forced ?? (Array.isArray(parsed) ? EContentType.JsonArray : EContentType.Json);

  if (hasRiskyNumber(text)) {
    return passthroughResult(text, contentType, 'precision-preserving passthrough');
  }

  const columnar = Array.isArray(parsed) ? compactArrayToColumnar(parsed) : null;
  // P2.3: an object KEYED by id with homogeneous values hoists to a columnar
  // `_omap` envelope — the array columnar's analogue for the common map shape.
  const objectMap = !Array.isArray(parsed) ? compactObjectMap(parsed) : null;
  const lossless = columnar
    ? JSON.stringify(columnar)
    : objectMap
      ? JSON.stringify({ _omap: objectMap })
      : (JSON.stringify(parsed) ?? 'null');

  // Lossy sampler is a LAST resort: only for a homogeneous array that, even
  // losslessly compacted, still exceeds an explicit `maxTokens` budget.
  const budget = opts.maxTokens;
  if (Array.isArray(parsed) && budget && budget > 0 && estimateTokens(lossless, contentType) > budget) {
    const sampled = sampleObjectArray(parsed, {
      ...(opts.query !== undefined ? { query: opts.query } : {}),
      ...(opts.maxItems !== undefined ? { maxItems: opts.maxItems } : {}),
    });
    if (sampled) {
      return finalizeLossy({
        original: text,
        body: JSON.stringify(sampled),
        contentType,
        strategy: ECompressionStrategy.Sample,
        opts,
        note: `${sampled._table.sample.dropped} of ${sampled._table.n} rows sampled`,
      });
    }
  }

  const savings = measureSavings(text, lossless, contentType);
  if (savings.after >= savings.before) return passthroughResult(text, contentType);
  return {
    compressed: lossless,
    contentType,
    strategy: columnar || objectMap ? ECompressionStrategy.Table : ECompressionStrategy.MinifiedJson,
    savings,
    lossy: false,
    note: columnar
      ? 'lossless columnar table (valid JSON; schema hoisted, keys deduped)'
      : objectMap
        ? 'lossless columnar object-map (valid JSON; schema hoisted, keys deduped)'
        : 'minified JSON (whitespace removed)',
  };
}
