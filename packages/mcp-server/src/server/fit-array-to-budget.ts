import { compactArrayToColumnar, compressJson, type ICcrStore } from '@shrkcrft/compress';

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
 * This routes through `compressJson({ maxTokens })`, which owns the
 * lossless-vs-lossy decision, so the big-array tools all budget identically.
 */
export function fitArrayToBudget(
  array: readonly unknown[],
  maxTokens: number | undefined,
  store?: ICcrStore,
): IFittedArray {
  const columnar = compactArrayToColumnar(array) ?? array;
  if (!maxTokens || maxTokens <= 0) return { value: columnar };

  const result = compressJson(JSON.stringify(array), {
    maxTokens,
    ...(store ? { store } : {}),
  });
  // A CCR key is set only on the lossy sample path; under budget the result is
  // the lossless columnar/minified form, so fall back to the columnar value.
  if (result.ccrKey) {
    const firstLine = result.compressed.split('\n')[0] ?? 'null';
    return { value: JSON.parse(firstLine), ccrKey: result.ccrKey };
  }
  return { value: columnar };
}
