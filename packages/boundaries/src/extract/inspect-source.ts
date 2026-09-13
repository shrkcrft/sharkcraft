import { normalizeWiringSource, type IWiringSource } from '@shrkcrft/core';
import { readSelectedFiles } from '../util/read-selected-files.ts';
import { readGlobListUnits } from '../util/dead-glob-units.ts';
import type { IGlobListUnits } from '../util/i-glob-list-units.ts';
import type { IUnreadFile } from '../util/unread-file.ts';
import { extractTokens, type IExtractedSite } from './extract-tokens.ts';
import { loadTsconfigPaths } from '../scan/tsconfig-aliases.ts';

/** What one source actually resolved to against the live tree. */
export interface ISourceInspection {
  /** Files the globs matched and the reader READ (after the shared walk's skip rules). */
  readonly filesScanned: number;
  /**
   * Files the globs matched that the reader did NOT read (over the read cap,
   * or unreadable). A source with any is not "matched nothing" and not fully
   * examined: its coverage names them (`readScopeCoverage`).
   */
  readonly unread: readonly IUnreadFile[];
  /** Distinct ids extracted, sorted. */
  readonly ids: readonly string[];
  /** Every capture site, in stable (file, line) order. */
  readonly sites: readonly IExtractedSite[];
  /** Set when the source is misconfigured. */
  readonly error?: string;
  /**
   * A diagnosis for a zero-match that is technically correct but almost
   * certainly not what the author meant — surfaced alongside the loud skip so
   * the dead end explains itself.
   */
  readonly hint?: string;
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
  rawSource: IWiringSource,
  excludeDirs: readonly string[] = [],
): ISourceInspection {
  // The engine entry normalises idempotently (round 13): a loaded source comes
  // back equal; a hand-built one with a `{ pattern, expectEmpty }` entry reads
  // its pattern as the glob, and a malformed entry is a misconfiguration —
  // never a glob reader handed an object.
  const normalized = normalizeWiringSource(rawSource);
  if (!normalized.ok) return { filesScanned: 0, unread: [], ids: [], sites: [], error: normalized.error.message };
  const source = normalized.value;
  const globs = source.files ?? [];
  const { files, unread } = sourceFiles(projectRoot, globs, excludeDirs);
  // `import-edges` resolves alias specifiers the way the compiler would, so it
  // needs the project's tsconfig paths. Loading it here (rather than inside the
  // extractor) keeps every extractor a pure function of its inputs.
  const res = extractTokens(source, files, { tsconfigPaths: loadTsconfigPaths(projectRoot) });
  const sites = [...res.sites].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.token.localeCompare(b.token),
  );
  return {
    filesScanned: files.length,
    unread,
    ids: [...new Set(sites.map((s) => s.token))].sort(),
    sites,
    ...(res.error ? { error: res.error } : {}),
    ...(res.hint ? { hint: res.hint } : {}),
  };
}

/**
 * ONE source's glob units: the dead ones (each with its reason), the live
 * negations with what each excludes, and how many globs were checked — through
 * the one dead-unit decision, `globListUnits`.
 *
 * It reads the same walk {@link inspectSource} reads (inside
 * `withFileReadCache` a second call over the same globs is a memo hit), so the
 * answer is about the files the source actually SEES — after `SKIP_DIRS` and
 * `excludeDirs`. The walk is the list's POSITIVE set (every file an inclusion
 * glob matched), so a negation is judged by what it removes from it, never by
 * what it "matches". A file over the read cap was still MATCHED, so a glob that
 * matched only such a file is not dead. Only `files[]` walk globs count: an
 * `import-edges` `to.files` matches resolved specifiers, not walked files.
 */
export function sourceGlobUnits(
  projectRoot: string,
  source: IWiringSource,
  excludeDirs: readonly string[] = [],
): IGlobListUnits {
  return readGlobListUnits(projectRoot, source.files ?? [], new Set(excludeDirs));
}

/**
 * The globs of ONE source that do nothing — a dead unit inside a rule whose
 * other globs may still keep it connected. The labels of
 * {@link sourceGlobUnits}`.dead` (a dead negation keeps its `!`).
 */
export function sourceDeadGlobs(
  projectRoot: string,
  source: IWiringSource,
  excludeDirs: readonly string[] = [],
): readonly string[] {
  return sourceGlobUnits(projectRoot, source, excludeDirs).dead.map((u) => u.glob);
}

/**
 * The files a source's glob list SELECTS (an inclusion glob matches, no
 * negation does), after the shared walk's skip rules: read, and unread.
 */
function sourceFiles(
  projectRoot: string,
  globs: readonly string[],
  excludeDirs: readonly string[],
): { files: { path: string; content: string }[]; unread: IUnreadFile[] } {
  const selected = readSelectedFiles(projectRoot, globs, new Set(excludeDirs));
  return {
    files: [...selected.files.entries()].map(([path, content]) => ({ path, content })),
    unread: [...selected.unread],
  };
}
