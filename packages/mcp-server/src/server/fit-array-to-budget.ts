import {
  compactArrayToColumnar,
  compressJson,
  estimateTokens,
  EContentType,
  type ICcrStore,
} from '@shrkcrft/compress';

export interface IFittedArray {
  /** The array shaped for output: lossless columnar, or a lossy sample. */
  value: unknown;
  /** Set when a lossy sample was taken — the CCR key for the cached original. */
  ccrKey?: string;
}

/**
 * Fit a homogeneous object array to an optional token budget (P5.2).
 *
 *  - No budget (or under budget): the lossless columnar form.
 *  - Over budget: the SmartCrusher row-sample (representative rows kept, the
 *    rest dropped) with the FULL original cached in `store` — the agent can
 *    `retrieve_original` with the returned `ccrKey`.
 *
 * `compressJson({ maxTokens })` owns the lossless-vs-lossy DECISION, but its
 * sampler keep-count is not derived from the budget, so a single sample can
 * still exceed `maxTokens`. We therefore binary-search the row cap so the
 * emitted payload actually fits the budget (down to a 1-row floor — a single
 * row's columnar envelope may still exceed a very small budget, which is the
 * best achievable while keeping any data).
 */
export function fitArrayToBudget(
  array: readonly unknown[],
  maxTokens: number | undefined,
  store?: ICcrStore,
): IFittedArray {
  const columnar = compactArrayToColumnar(array) ?? array;
  if (!maxTokens || maxTokens <= 0) return { value: columnar };

  const json = JSON.stringify(array);
  const run = (maxItems?: number): IFittedArray | null => {
    const r = compressJson(json, {
      maxTokens,
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(store ? { store } : {}),
    });
    // A CCR key is set only on the lossy sample path; under budget the result
    // is the lossless form, so the caller falls back to the columnar value.
    if (!r.ccrKey) return null;
    const firstLine = r.compressed.split('\n')[0] ?? 'null';
    return { value: JSON.parse(firstLine), ccrKey: r.ccrKey };
  };

  const fits = (fitted: IFittedArray): boolean =>
    estimateTokens(JSON.stringify(fitted.value), EContentType.JsonArray) <= maxTokens;

  // Default sample (no cap). Null → under budget, emit the lossless form.
  const initial = run();
  if (!initial) return { value: columnar };
  if (fits(initial)) return initial;

  // Largest row cap whose sampled payload still fits the budget.
  let lo = 1;
  let hi = array.length;
  let best: IFittedArray | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = run(mid);
    if (candidate && fits(candidate)) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Even one row over budget → keep the smallest sample (best effort, still
  // recoverable via ccrKey) rather than the much larger default sample.
  return best ?? run(1) ?? initial;
}
