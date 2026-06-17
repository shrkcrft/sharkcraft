import type { EVolatileKind } from './volatile-kind.ts';
import { clean, classify, MIN_VOLATILE_LEN } from './volatile-classify.ts';
import { formatPlaceholder, escapePlaceholders } from './placeholder.ts';
import type { IAlignmentBinding, IAlignmentMap } from './alignment-map.ts';
import type { IAlignmentResult } from './alignment-result.ts';

/**
 * Replace volatile tokens (UUID/JWT/ISO-8601/hex/epoch) with stable, kind-tagged
 * placeholders so a provider KV-cache prefix stays steady across turns.
 * Reversible via `restoreVolatileTokens`. Deterministic and pure: the caller's
 * `prior` map is never mutated (cloned), ordinals are assigned strictly in scan
 * order, and the same `(text, prior)` yields byte-identical output. Shares
 * `clean`/`classify` with `detectVolatileTokens`, so the two never disagree on
 * what is volatile.
 */
export function alignVolatileTokens(text: string, prior?: IAlignmentMap): IAlignmentResult {
  const bindings: IAlignmentBinding[] = prior ? prior.bindings.map((b) => ({ ...b })) : [];
  const byOriginal = new Map<string, IAlignmentBinding>();
  const nextOrdinal = new Map<EVolatileKind, number>();
  for (const b of bindings) {
    byOriginal.set(b.original, b);
    nextOrdinal.set(b.kind, Math.max(nextOrdinal.get(b.kind) ?? 0, b.ordinal));
  }

  let replaced = 0;
  // Escape any pre-existing `«vk:…»`-shaped literal so a generated placeholder
  // can never collide with content that was already there (restore stays exact).
  const safe = escapePlaceholders(text);
  // Split keeping whitespace runs so they survive verbatim.
  const aligned = safe
    .split(/(\s+)/)
    .map((segment) => {
      if (segment.length === 0 || /^\s+$/.test(segment)) return segment;
      const cleaned = clean(segment);
      if (cleaned.length < MIN_VOLATILE_LEN) return segment;
      const kind = classify(cleaned);
      if (!kind) return segment;
      let binding = byOriginal.get(cleaned);
      if (!binding) {
        const ordinal = (nextOrdinal.get(kind) ?? 0) + 1;
        nextOrdinal.set(kind, ordinal);
        binding = { placeholder: formatPlaceholder(kind, ordinal), original: cleaned, kind, ordinal };
        bindings.push(binding);
        byOriginal.set(cleaned, binding);
      }
      replaced += 1;
      // Replace the cleaned span inside the raw segment so wrappers like
      // `"<uuid>",` keep their surrounding quotes/punctuation.
      return segment.replace(cleaned, binding.placeholder);
    })
    .join('');

  return { aligned, map: { version: 1, bindings }, replaced };
}
