import { EVolatileKind } from './volatile-kind.ts';
import type { IVolatileToken } from './volatile-token.ts';
import { clean, classify, MIN_VOLATILE_LEN } from './volatile-classify.ts';

/**
 * Scan text for volatile tokens that would bust a provider KV-cache prefix.
 * Deterministic, detection-only (never mutates). Returns one aggregated entry
 * per kind found, in a stable kind order, with an occurrence count and a
 * truncated sample. Shares its `clean`/`classify` with `alignVolatileTokens`
 * so the two never disagree.
 */
export function detectVolatileTokens(text: string): IVolatileToken[] {
  const counts = new Map<EVolatileKind, number>();
  const samples = new Map<EVolatileKind, string>();
  for (const raw of text.split(/\s+/)) {
    if (raw.length === 0) continue;
    const token = clean(raw);
    if (token.length < MIN_VOLATILE_LEN) continue;
    const kind = classify(token);
    if (!kind) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (!samples.has(kind)) samples.set(kind, token.slice(0, 24));
  }
  // Stable kind order so output is deterministic regardless of scan order.
  const order: EVolatileKind[] = [
    EVolatileKind.Uuid,
    EVolatileKind.Jwt,
    EVolatileKind.Iso8601,
    EVolatileKind.HexHash,
    EVolatileKind.EpochTimestamp,
  ];
  const out: IVolatileToken[] = [];
  for (const kind of order) {
    const count = counts.get(kind);
    if (count) out.push({ kind, count, sample: samples.get(kind) ?? '' });
  }
  return out;
}
