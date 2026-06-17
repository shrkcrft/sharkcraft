import { PLACEHOLDER_RE, unescapePlaceholders } from './placeholder.ts';
import type { IAlignmentMap } from './alignment-map.ts';

/**
 * Reverse `alignVolatileTokens`: replace every `«vk:…»` placeholder with its
 * original value from the map. Unknown placeholders pass through untouched
 * (total, never throws). Property:
 * `restoreVolatileTokens(alignVolatileTokens(t).aligned, map) === t` for any `t`
 * whose volatile tokens were cleanly delimited (lossless-via-restore).
 */
export function restoreVolatileTokens(text: string, map: IAlignmentMap): string {
  const byPlaceholder = new Map(map.bindings.map((b) => [b.placeholder, b.original]));
  // Revert generated placeholders, then unescape any literal `«vk:…»` that
  // align escaped — so the round trip is exact even for placeholder-shaped input.
  const reverted = text.replace(PLACEHOLDER_RE, (match) => byPlaceholder.get(match) ?? match);
  return unescapePlaceholders(reverted);
}
