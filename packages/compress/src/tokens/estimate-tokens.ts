import type { ITokenSavings } from './token-savings.ts';
import { EContentType } from '../content/content-type.ts';

/**
 * Chars-per-token by content class. Denser content (JSON punctuation, code
 * operators) packs more characters per BPE token than prose, so a LARGER
 * divisor yields a LOWER (more accurate) token estimate. Prose stays at 4 —
 * the exact legacy value — so the untyped path is byte-identical.
 */
const CHARS_PER_TOKEN: Readonly<Record<EContentType, number>> = Object.freeze({
  [EContentType.JsonArray]: 2.5,
  [EContentType.Json]: 2.5,
  [EContentType.GitDiff]: 3.0,
  [EContentType.SearchResults]: 3.0,
  [EContentType.BuildLog]: 3.5,
  [EContentType.SourceCode]: 3.2,
  [EContentType.Markdown]: 4.0,
  [EContentType.Yaml]: 3.5,
  [EContentType.Csv]: 3.0,
  [EContentType.PlainText]: 4.0,
});

/**
 * The legacy divisor. With no content type, `estimateTokens` reproduces the
 * exact `max(ceil(chars/4), ceil(words*1.3))` formula bit-for-bit, keeping it
 * in lockstep with `@shrkcrft/context`'s separate estimator. DO NOT change this
 * default or the `words*1.3` floor without updating that peer in step.
 */
const DEFAULT_CHARS_PER_TOKEN = 4;

/**
 * Approximate token count. Average English token ≈ 4 chars; denser classes use
 * a class-specific ratio when `contentType` is supplied. Only the character
 * term is typed — the `words * 1.3` floor is content-independent. Pure: reads
 * only its args + a frozen table.
 */
export function estimateTokens(text: string, contentType?: EContentType): number {
  if (!text) return 0;
  const divisor =
    contentType === undefined ? DEFAULT_CHARS_PER_TOKEN : CHARS_PER_TOKEN[contentType];
  const chars = text.length;
  const words = text.trim().split(/\s+/).length;
  return Math.max(Math.ceil(chars / divisor), Math.ceil(words * 1.3));
}

/**
 * Measure the token delta between a before/after string (optionally typed).
 * Clamps at zero so a compressor is never reported as a net loss. Both sides
 * use the same `contentType`, so a uniform divisor cannot flip a real
 * reduction into a false passthrough.
 */
export function measureSavings(
  before: string,
  after: string,
  contentType?: EContentType,
): ITokenSavings {
  const b = estimateTokens(before, contentType);
  const a = estimateTokens(after, contentType);
  const saved = Math.max(0, b - a);
  const ratio = b === 0 ? 0 : Math.round((saved / b) * 10000) / 10000;
  return { before: b, after: a, saved, ratio };
}
