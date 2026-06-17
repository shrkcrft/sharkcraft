/**
 * Optional real-BPE-tokenizer helper for MEASUREMENT / UI surfaces only.
 *
 * The deterministic engine never imports this. `gpt-tokenizer` (cl100k_base) is
 * a lookup table, not a model, but it is still a *dev* dependency: pulling it
 * onto the engine path would break the "pure function of input, no extra deps"
 * contract. So it lives here, behind a guarded dynamic import, and every caller
 * degrades gracefully to the estimator when it is absent (e.g. a published
 * install that never shipped the dev dependency).
 *
 * cl100k_base is the standard public proxy for Claude's (non-public) tokenizer;
 * BPE token counts track closely. Treat the numbers as "exact for cl100k_base",
 * not "exact for Claude".
 */

/** A loaded tokenizer: maps a string to its exact BPE token count. */
export type RealTokenizer = (text: string) => number;

/**
 * Attempt to load a real BPE tokenizer. Returns a synchronous counting function
 * when the dependency is present, or `null` when it cannot be loaded — callers
 * MUST handle the null and fall back to the deterministic estimator.
 *
 * `moduleId` is injectable purely so tests can force the graceful-absence path
 * deterministically (pass a module id that does not resolve).
 */
export async function loadRealTokenizer(
  moduleId = 'gpt-tokenizer',
): Promise<RealTokenizer | null> {
  try {
    const mod = (await import(moduleId)) as { encode?: (s: string) => number[] };
    if (typeof mod?.encode !== 'function') return null;
    const encode = mod.encode;
    return (text: string): number => (text ? encode(text).length : 0);
  } catch {
    return null;
  }
}

/**
 * Convenience: count tokens in one string, or `null` if no tokenizer is
 * available. Prefer {@link loadRealTokenizer} when counting many strings so the
 * dynamic import is paid once.
 */
export async function realTokens(
  text: string,
  moduleId = 'gpt-tokenizer',
): Promise<number | null> {
  const tok = await loadRealTokenizer(moduleId);
  return tok ? tok(text) : null;
}
