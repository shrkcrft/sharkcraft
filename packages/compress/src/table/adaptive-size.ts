import { deflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

/**
 * Adaptive sample sizing — pick how many items to keep from the *shape of the
 * information*, not a fixed K. Fixed caps keep too much on redundant data and
 * too little on diverse data. {@link computeOptimalK} finds the knee of the
 * unique-bigram coverage curve (where adding more items stops adding
 * information), cross-checked against simhash near-duplicate collapse and a
 * zlib redundancy bound.
 *
 * Pure and deterministic: a function of the input bytes only (no clock, no RNG,
 * no learned state). zlib `deflate` is a fixed, deterministic transform — a
 * lookup-driven coder, not a model — used only as a redundancy *measure*.
 */

export type AdaptiveBias = 'conservative' | 'moderate' | 'aggressive';

export interface IAdaptiveOptions {
  /** Lower bound on the result (e.g. a representative-rows floor). Default 1. */
  min?: number;
  /** Upper bound on the result (e.g. an existing fixed cap). Default items.length. */
  max?: number;
  /** Shifts the knee: keep more (conservative) or fewer (aggressive). Default 'moderate'. */
  bias?: AdaptiveBias;
}

const BIAS_FACTOR: Record<AdaptiveBias, number> = {
  conservative: 1.5,
  moderate: 1.0,
  aggressive: 0.6,
};

/** Hamming distance below which two simhashes are "the same information". */
const NEAR_DUP_HAMMING = 6;
/** A coverage curve flatter than this (max knee deflection) is "diverse" → keep max. */
const FLATNESS_EPSILON = 0.08;

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** The set of adjacent token bigrams in one item (unigrams when it has one token). */
function bigrams(text: string): Set<string> {
  const toks = tokenize(text);
  if (toks.length <= 1) return new Set(toks);
  const out = new Set<string>();
  for (let i = 0; i + 1 < toks.length; i += 1) out.add(`${toks[i]}${toks[i + 1]}`);
  return out;
}

/**
 * A 32-bit simhash over an item's token bigrams. Near-identical items map to
 * near-identical hashes (small Hamming distance), so redundant rows don't each
 * count as "new information".
 */
export function simhash(text: string): number {
  return simhashOfGrams(bigrams(text));
}

/** Simhash over an already-computed bigram set (so callers can reuse the set). */
function simhashOfGrams(grams: ReadonlySet<string>): number {
  const v = new Array<number>(32).fill(0);
  for (const g of grams) {
    const h = hash32(g);
    for (let b = 0; b < 32; b += 1) v[b]! += (h >>> b) & 1 ? 1 : -1;
  }
  let out = 0;
  for (let b = 0; b < 32; b += 1) if (v[b]! > 0) out |= 1 << b;
  return out >>> 0;
}

function hash32(s: string): number {
  // FNV-1a — a fixed, deterministic non-cryptographic hash.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function hammingDistance(a: number, b: number): number {
  let x = (a ^ b) >>> 0;
  let count = 0;
  while (x !== 0) {
    x &= x - 1;
    count += 1;
  }
  return count;
}

/**
 * Index of the knee of a monotone-nondecreasing curve via Kneedle: the point of
 * maximum deflection from the chord between its endpoints. Returns `{ index,
 * deflection }` where `deflection` is ~0 for a straight (no-knee) curve.
 */
export function kneedle(curve: readonly number[]): { index: number; deflection: number } {
  const n = curve.length;
  if (n <= 2) return { index: n - 1, deflection: 0 };
  const first = curve[0]!;
  const last = curve[n - 1]!;
  const span = last - first;
  if (span <= 0) return { index: 0, deflection: 0 };
  let bestIdx = n - 1;
  let bestDef = 0;
  for (let i = 0; i < n; i += 1) {
    const xNorm = i / (n - 1);
    const yNorm = (curve[i]! - first) / span;
    const def = yNorm - xNorm; // concave (saturating) curves bulge above the chord
    if (def > bestDef) {
      bestDef = def;
      bestIdx = i;
    }
  }
  return { index: bestIdx, deflection: bestDef };
}

/** The cumulative count of distinct bigrams as items are added in order. */
export function bigramCoverageCurve(items: readonly string[]): number[] {
  return coverageFromGrams(items.map(bigrams));
}

/** Cumulative distinct-bigram curve over already-computed gram sets. */
function coverageFromGrams(gramSets: ReadonlyArray<ReadonlySet<string>>): number[] {
  const seen = new Set<string>();
  const curve: number[] = [];
  for (const grams of gramSets) {
    for (const g of grams) seen.add(g);
    curve.push(seen.size);
  }
  return curve;
}

/** Recent-hash window for the near-dup scan, keeping it O(n) on large inputs. */
const NEAR_DUP_WINDOW = 64;

/**
 * Count of items that are NOT a simhash near-duplicate of a RECENT earlier item.
 * Bounded to a sliding window so it stays linear; near-duplicates in sampler
 * data cluster locally, and this is only an upper-bound cross-check anyway.
 */
function uniqueFromGrams(gramSets: ReadonlyArray<ReadonlySet<string>>): number {
  const window: number[] = [];
  let unique = 0;
  for (const grams of gramSets) {
    const h = simhashOfGrams(grams);
    if (!window.some((k) => hammingDistance(k, h) <= NEAR_DUP_HAMMING)) {
      unique += 1;
      window.push(h);
      if (window.length > NEAR_DUP_WINDOW) window.shift();
    }
  }
  return unique;
}

/** zlib redundancy ratio of the joined corpus in (0, 1]; lower ⇒ more redundant. */
function zlibRedundancy(items: readonly string[]): number {
  const raw = items.join('\n');
  if (raw.length === 0) return 1;
  const deflated = deflateSync(Buffer.from(raw, 'utf8')).length;
  return Math.min(1, deflated / Buffer.byteLength(raw, 'utf8'));
}

/**
 * Choose how many of `items` to keep. Deterministic. The result is clamped to
 * `[min, max]` (and never exceeds `items.length`), so an explicit cap passed as
 * `max` is always honoured.
 */
export function computeOptimalK(items: readonly string[], opts: IAdaptiveOptions = {}): number {
  const n = items.length;
  const min = Math.max(1, opts.min ?? 1);
  const max = Math.min(opts.max ?? n, n);
  if (n <= min) return n;
  if (max <= min) return min;

  // Tokenize + bigram each item ONCE, then reuse the sets for both the coverage
  // curve and the simhash near-dup scan (was computed twice).
  const gramSets = items.map(bigrams);
  const curve = coverageFromGrams(gramSets);
  const knee = kneedle(curve);

  let k: number;
  if (knee.deflection < FLATNESS_EPSILON) {
    // Near-linear coverage ⇒ each item adds information ⇒ keep the most.
    k = max;
  } else {
    k = knee.index + 1;
  }

  // Bias shifts how far past the knee we keep.
  k = Math.round(k * BIAS_FACTOR[opts.bias ?? 'moderate']);

  // Never keep more than the number of non-near-duplicate items.
  k = Math.min(k, uniqueFromGrams(gramSets));

  // Very redundant corpora (low zlib ratio) pull K down toward the floor.
  if (zlibRedundancy(items) < 0.25) k = Math.min(k, Math.max(min, Math.ceil(max * 0.25)));

  return Math.max(min, Math.min(max, k));
}
