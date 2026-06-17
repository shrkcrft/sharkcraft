import { PLACEHOLDER_RE, unescapePlaceholders } from './placeholder.ts';
import type { IAlignmentBinding, IAlignmentMap } from './alignment-map.ts';

/**
 * Reverse `alignVolatileTokens`: replace every `«vk:…»` placeholder with its
 * original value from the map. Unknown placeholders pass through untouched
 * (total, never throws). Property:
 * `restoreVolatileTokens(alignVolatileTokens(t).aligned, map) === t` for any `t`
 * whose volatile tokens were cleanly delimited (lossless-via-restore).
 */
export function restoreVolatileTokens(text: string, map: IAlignmentMap): string {
  // Defensive: a corrupt/hand-edited map may carry a non-object (or
  // placeholder-less) element in `bindings[]` that still passes a shallow
  // `Array.isArray` validation. Skip those so the documented "never throws"
  // guarantee holds rather than dereferencing `b.placeholder` on `null`.
  const byPlaceholder = new Map(
    (Array.isArray(map.bindings) ? map.bindings : [])
      .filter(
        (b): b is IAlignmentBinding =>
          b != null && typeof b === 'object' && typeof (b as IAlignmentBinding).placeholder === 'string',
      )
      .map((b) => [b.placeholder, b.original]),
  );
  // Revert generated placeholders, then unescape any literal `«vk:…»` that
  // align escaped — so the round trip is exact even for placeholder-shaped input.
  const reverted = text.replace(PLACEHOLDER_RE, (match) => byPlaceholder.get(match) ?? match);
  return unescapePlaceholders(reverted);
}
