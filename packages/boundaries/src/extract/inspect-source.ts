import type { IWiringSource } from '@shrkcrft/core';
import { matchesAny } from '../scan/glob.ts';
import { readMatchingFiles } from '../util/walk-files.ts';
import { extractTokens, type IExtractedSite } from './extract-tokens.ts';

/** What one source actually resolved to against the live tree. */
export interface ISourceInspection {
  /** Files the globs matched (after the shared walk's skip rules). */
  readonly filesScanned: number;
  /** Distinct ids extracted, sorted. */
  readonly ids: readonly string[];
  /** Every capture site, in stable (file, line) order. */
  readonly sites: readonly IExtractedSite[];
  /** Set when the source is misconfigured. */
  readonly error?: string;
}

/**
 * Resolve ONE source against the tree and report what it matched.
 *
 * This is the primitive behind the rule-authoring trust layer: every plane
 * (wiring, registry, registration idioms, extractor baselines) is ultimately a
 * set of these, so "how many files did this rule see, and which ids did it
 * extract?" has one answer computed one way. A rule that matched 0 is then a
 * fact the tooling can report, not something an author has to notice.
 */
export function inspectSource(
  projectRoot: string,
  source: IWiringSource,
  excludeDirs: readonly string[] = [],
): ISourceInspection {
  const globs = source.files ?? [];
  const cache = readMatchingFiles(projectRoot, globs, new Set(excludeDirs));
  const files = [...cache.entries()]
    .filter(([path]) => matchesAny(path, globs))
    .map(([path, content]) => ({ path, content }));
  const res = extractTokens(source, files);
  const sites = [...res.sites].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.token.localeCompare(b.token),
  );
  return {
    filesScanned: files.length,
    ids: [...new Set(sites.map((s) => s.token))].sort(),
    sites,
    ...(res.error ? { error: res.error } : {}),
  };
}
