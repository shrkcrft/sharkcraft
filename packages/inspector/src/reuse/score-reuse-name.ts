import { ReuseNameMatch } from '@shrkcrft/core';
import { tokenizeReuseIntent } from './reuse-tokenize.ts';

/**
 * How `symbol`'s NAME matches the intent `tokens` — by token EQUALITY on the
 * split identifier, never substring: `ran` does not match `DateRange`.
 *
 * The name goes through the same normaliser as the intent
 * ({@link tokenizeReuseIntent}), so a prefix the intent can never carry (the
 * `I` of `IDateRangePickerOptions`, a `use` of `useDebounce`) does not stop
 * an exact match.
 */
export function scoreReuseName(symbol: string, tokens: readonly string[]): ReuseNameMatch {
  const intent = new Set(tokens);
  if (intent.size === 0) return ReuseNameMatch.None;
  const name = new Set(tokenizeReuseIntent(symbol));
  let hits = 0;
  for (const t of intent) if (name.has(t)) hits += 1;
  if (hits === 0) return ReuseNameMatch.None;
  if (hits < intent.size) return ReuseNameMatch.Partial;
  return name.size === intent.size ? ReuseNameMatch.Exact : ReuseNameMatch.Covers;
}

/** The intent tokens (in intent order) that equal one of `symbol`'s name tokens. */
export function reuseNameHits(symbol: string, tokens: readonly string[]): string[] {
  const name = new Set(tokenizeReuseIntent(symbol));
  return [...new Set(tokens)].filter((t) => name.has(t));
}

/** How many of `symbol`'s name tokens the intent did NOT name — 0 is the closest name. */
export function reuseNameExtraTokens(symbol: string, tokens: readonly string[]): number {
  return new Set(tokenizeReuseIntent(symbol)).size - reuseNameHits(symbol, tokens).length;
}
