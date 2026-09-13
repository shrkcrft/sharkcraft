import type { IWiringSource } from '@shrkcrft/core';
import { readSelectedFiles } from '../util/read-selected-files.ts';
import type { IUnreadFile } from '../util/unread-file.ts';
import { loadTsconfigPaths } from '../scan/tsconfig-aliases.ts';
import { extractTokens } from '../extract/extract-tokens.ts';

/** The value an extractor-backed baseline computes, ready to diff or commit. */
export interface IExtractorCompute {
  /** Canonical serialization: a pretty-printed JSON array of sorted, unique ids. */
  readonly text: string;
  readonly ids: readonly string[];
  /** Matched files the compute READ. */
  readonly filesScanned: number;
  /**
   * Matched files the reader did NOT read (over the read cap, or unreadable).
   * The recompute is incomplete without them: an id only they hold is missing
   * from `ids`, so the baseline's coverage names them and never reads clean.
   */
  readonly unread: readonly IUnreadFile[];
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
  // The files the source's list SELECTS — a `!` entry excludes, so an id only
  // an excluded file holds is not in the recomputed ledger.
  const selected = readSelectedFiles(projectRoot, source.files ?? [], new Set(excludeDirs));
  const files = [...selected.files.entries()].map(([path, content]) => ({ path, content }));
  const unread = selected.unread;
  const res = extractTokens(source, files, { tsconfigPaths: loadTsconfigPaths(projectRoot) });
  if (res.error) {
    return { text: '[]', ids: [], filesScanned: files.length, unread, error: res.error };
  }
  const ids = [...new Set(res.sites.map((s) => s.token))].sort();
  return {
    text: JSON.stringify(ids, null, 2) + '\n',
    ids,
    filesScanned: files.length,
    unread,
  };
}
