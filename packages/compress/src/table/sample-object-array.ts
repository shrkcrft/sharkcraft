import type { ISampleOptions } from './sample-options.ts';
import type { ISampledTable } from './sampled-table.ts';
import { compactObjectArray } from './compact-object-array.ts';
import { applyValueDictionaries } from './apply-value-dictionaries.ts';
import { computeOptimalK } from './adaptive-size.ts';
import { topByBm25 } from '../relevance/bm25.ts';
import { queryTokens } from '../text/line-utils.ts';

type Bucket = 'head' | 'tail' | 'match' | 'outlier';
// Query matches rank ABOVE front/back anchors: when the caller asked about
// something specific, a relevant row matters more than a positional anchor
// under a tight cap. With no query there are no matches, so anchors lead as before.
const PRECEDENCE: Record<Bucket, number> = { match: 0, head: 1, tail: 2, outlier: 3 };

/** Auto-pick the numeric column with the highest variance (ties → column name). */
function pickOutlierField(
  cols: ReadonlyArray<{ name: string; type: string }>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
): string | undefined {
  let best: { name: string; variance: number } | undefined;
  for (let c = 0; c < cols.length; c += 1) {
    const spec = cols[c]!;
    if (spec.type !== 'int' && spec.type !== 'float') continue;
    const nums: number[] = [];
    for (const row of rows) {
      const v = row[c];
      if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
    }
    if (nums.length < 2) continue;
    const mean = nums.reduce((s, v) => s + v, 0) / nums.length;
    const variance = nums.reduce((s, v) => s + (v - mean) * (v - mean), 0) / nums.length;
    if (!best || variance > best.variance || (variance === best.variance && spec.name < best.name)) {
      best = { name: spec.name, variance };
    }
  }
  return best?.name;
}

/**
 * SmartCrusher-style lossy sampler for a homogeneous object array. Keeps
 * representative rows — front/back anchors, query matches, numeric outliers,
 * one per dedup class — and drops the rest, in ascending original order, with
 * full provenance. Pure and deterministic (no RNG/clock; ties break by index).
 * Returns `null` if the input isn't a homogeneous object array.
 */
export function sampleObjectArray(items: unknown, opts: ISampleOptions = {}): ISampledTable | null {
  const table = compactObjectArray(items);
  if (!table) return null;
  const { cols, rows, absent, originalCount } = table;

  const anchors = opts.anchors ?? 8;
  const outliersN = opts.outliers ?? 8;
  const matchesN = opts.matches ?? 16;
  // P3.1: with no explicit cap, size the keep-set from the data's information
  // curve instead of a flat 200. Floored at the representative budget so the
  // adaptive cap never trims the bucket reps (anchors/matches/outliers) — it
  // only declines to over-keep on large redundant arrays. An explicit
  // `maxItems` always wins.
  const repBudget = anchors * 2 + matchesN + outliersN * 2;
  const maxItems =
    opts.maxItems && opts.maxItems > 0
      ? opts.maxItems
      : computeOptimalK(rows.map((r) => JSON.stringify(r)), {
          min: Math.min(repBudget, rows.length),
          max: 200,
          ...(opts.bias ? { bias: opts.bias } : {}),
        });
  const tokens = queryTokens(opts.query);

  // 1. Dedup → representatives (smallest index per byte-identical row).
  let repIdx: number[];
  let deduped = 0;
  if (opts.dedup !== false) {
    const seen = new Map<string, number>();
    for (let i = 0; i < rows.length; i += 1) {
      const key = JSON.stringify(rows[i]);
      if (!seen.has(key)) seen.set(key, i);
      else deduped += 1;
    }
    repIdx = [...seen.values()].sort((a, b) => a - b);
  } else {
    repIdx = rows.map((_, i) => i);
  }

  // 2. Bucket selection (record first bucket that claimed each index).
  const bucketOf = new Map<number, Bucket>();
  const claim = (i: number, b: Bucket): void => {
    if (!bucketOf.has(i)) bucketOf.set(i, b);
  };
  for (const i of repIdx.slice(0, anchors)) claim(i, 'head');
  for (const i of repIdx.slice(Math.max(0, repIdx.length - anchors))) claim(i, 'tail');
  if (tokens.length > 0 && opts.query) {
    // P3.2: rank query matches by BM25 (idf-weighted, length-normalized, with an
    // exact-match boost for ID-shaped terms) instead of bare token overlap, so a
    // uniquely-relevant row outranks one that merely repeats a common word.
    const docs = repIdx.map((i) => JSON.stringify(rows[i]));
    for (const localIdx of topByBm25(opts.query, docs, matchesN)) {
      claim(repIdx[localIdx]!, 'match');
    }
  }
  const sortField = opts.outlierField ?? pickOutlierField(cols, rows);
  if (sortField) {
    const col = cols.findIndex((c) => c.name === sortField);
    if (col >= 0) {
      const vals = repIdx
        .map((i) => ({ i, v: rows[i]?.[col] }))
        .filter((x): x is { i: number; v: number } => typeof x.v === 'number' && Number.isFinite(x.v))
        .sort((a, b) => a.v - b.v || a.i - b.i);
      for (const { i } of vals.slice(0, outliersN)) claim(i, 'outlier');
      for (const { i } of vals.slice(Math.max(0, vals.length - outliersN))) claim(i, 'outlier');
    }
  }

  // 3. Hard cap by precedence, always keeping the first & last representative.
  let chosen = [...bucketOf.keys()];
  if (chosen.length > maxItems) {
    const firstRep = repIdx[0];
    const lastRep = repIdx[repIdx.length - 1];
    const forced = new Set<number>();
    if (firstRep !== undefined) forced.add(firstRep);
    // Only force the last endpoint if the cap has room — otherwise maxItems=1
    // would over-keep 2 rows.
    if (lastRep !== undefined && forced.size < maxItems) forced.add(lastRep);
    const ranked = chosen
      .filter((i) => !forced.has(i))
      .sort((a, b) => PRECEDENCE[bucketOf.get(a)!] - PRECEDENCE[bucketOf.get(b)!] || a - b);
    const out = new Set<number>(forced);
    for (const i of ranked) {
      if (out.size >= maxItems) break;
      out.add(i);
    }
    chosen = [...out];
  }
  const keptSorted = chosen.sort((a, b) => a - b);

  // 4. Build the sampled table (ascending original order; remap absent).
  const newIndexOf = new Map<number, number>();
  keptSorted.forEach((orig, idx) => newIndexOf.set(orig, idx));
  const keptRows = keptSorted.map((i) => rows[i] ?? []);
  const keptAbsent: Array<[number, number]> = [];
  for (const [r, c] of absent) {
    const nr = newIndexOf.get(r);
    if (nr !== undefined) keptAbsent.push([nr, c]);
  }
  const count = (b: Bucket): number => keptSorted.filter((i) => bucketOf.get(i) === b).length;

  // Value-dictionary encode the kept rows (over kept indices, so dict + indices
  // align). Decoded by the same expandColumnar deref the lossless path uses.
  const colNames = cols.map((c) => c.name);
  const { rows: dictRows, dict } = applyValueDictionaries(colNames, keptRows, keptAbsent);

  return {
    _table: {
      cols: colNames,
      rows: dictRows,
      absent: keptAbsent,
      ...(dict ? { dict } : {}),
      n: originalCount,
      sample: {
        kept: keptSorted.length,
        dropped: originalCount - keptSorted.length,
        anchorsHead: count('head'),
        anchorsTail: count('tail'),
        outliers: count('outlier'),
        matches: count('match'),
        deduped,
        srcRows: keptSorted,
        ...(sortField ? { sortField } : {}),
      },
    },
  };
}
