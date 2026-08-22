import type { IWiringSource } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import { extractTokens } from '../extract/extract-tokens.ts';

/** The value an extractor-backed baseline computes, ready to diff or commit. */
export interface IExtractorCompute {
  /** Canonical serialization: a pretty-printed JSON array of sorted, unique ids. */
  readonly text: string;
  readonly ids: readonly string[];
  readonly filesScanned: number;
  /** Set when the source is misconfigured (never throws). */
  readonly error?: string;
}

/**
 * Compute a baseline from the extraction DSL — the pure alternative to shelling
 * out.
 *
 * Emitted as a pretty-printed JSON array so the committed artifact is valid
 * JSON *and* diffs one id per line: a review can see exactly which entry was
 * gained or lost without a tool.
 *
 * No spawn, no network, no model — so an extractor baseline is safe to ship
 * from a pack, unlike a `command` one.
 */
export function computeBaselineFromExtractor(
  projectRoot: string,
  source: IWiringSource,
  excludeDirs: readonly string[] = [],
): IExtractorCompute {
  const cache = readMatchingFiles(projectRoot, source.files ?? [], new Set(excludeDirs));
  const files = [...cache.entries()]
    .filter(([path]) => matchesAny(path, source.files ?? []))
    .map(([path, content]) => ({ path, content }));
  const res = extractTokens(source, files);
  if (res.error) {
    return { text: '[]', ids: [], filesScanned: files.length, error: res.error };
  }
  const ids = [...new Set(res.sites.map((s) => s.token))].sort();
  return {
    text: JSON.stringify(ids, null, 2) + '\n',
    ids,
    filesScanned: files.length,
  };
}
