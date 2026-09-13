import { globListSelects } from '../scan/glob.ts';
import type { IMatchedFiles } from './matched-files.ts';
import { unreadMatching } from './read-scope-coverage.ts';
import { readMatchingFiles } from './walk-files.ts';

/**
 * THE reader for ONE glob list: the one reader's positive walk
 * (`readMatchingFiles`, memoised), narrowed to the files the list SELECTS
 * (`globListSelects` — an inclusion glob matches, no negation does) and to the
 * unread entries in front of it (`unreadMatching`, negation-aware).
 *
 * Every single-list plane reader goes through here — an extraction source, an
 * extractor baseline, a doc-reference rule, a generated tree, a trace — so "which
 * files does this list read?" has one answer, and an over-cap file the author
 * excluded never makes the rule PARTIAL. A caller walking the UNION of several
 * lists must not use this on the union (one list's `!` would leak into
 * another's scope): walk the union, then select per list.
 */
export function readSelectedFiles(
  root: string,
  globs: readonly string[],
  excludeDirs: ReadonlySet<string> = new Set(),
  allowDotDirs: ReadonlySet<string> = new Set(),
): IMatchedFiles {
  const matched = readMatchingFiles(root, globs, excludeDirs, allowDotDirs);
  const files = new Map<string, string>();
  for (const [path, content] of matched.files) {
    if (globListSelects(path, globs)) files.set(path, content);
  }
  return { files, unread: Object.freeze(unreadMatching(matched.unread, globs)) };
}
