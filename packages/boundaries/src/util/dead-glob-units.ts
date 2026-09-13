import { normalizeUnitList, unitProblemsOf } from '@shrkcrft/core';
import { globListParts, globMayMatchUnder, globToRegex, matchesAny, measureGlobList } from '../scan/glob.ts';
import type { IDeadGlobUnit } from './i-dead-glob-unit.ts';
import type { IGlobListUnits } from './i-glob-list-units.ts';
import type { IGlobNegation } from './i-glob-negation.ts';
import { isUnreadDirectory, unreadEntryMatches } from './read-scope-coverage.ts';
import type { IUnreadFile } from './unread-file.ts';
import { readMatchingFiles } from './walk-files.ts';

/**
 * THE dead-unit decision for a gate-plane glob list — every plane that reports
 * a dead glob (an extraction source, a policy rule's `files`, a command
 * baseline's `watchFiles` probe) reads it here, so "is this glob live?" is not
 * answered three slightly different ways.
 *
 * `positivePaths` is what the walk returned (it may be a union wider than this
 * list — only paths one of THIS list's inclusion globs matches are its positive
 * set); `unread` is the reader's unread entries.
 *
 * - An INCLUSION glob is dead when it selects nothing that survives the list's
 *   negations and is in front of no unread entry the list keeps in scope:
 *   `matched 0 files`, or `matches only files the list's negations exclude (N)`.
 * - A NEGATION is alive when it removes at least one file from its own list's
 *   positive set (a read file, or a matched-but-unread one), or could match
 *   beneath an unlistable directory the list's inclusion globs reach. Otherwise
 *   it is dead with `excludes nothing — none of the N file(s) the other globs
 *   select match it`. A negation is never judged by what it matches on its own:
 *   it matches nothing by itself; it subtracts. (Before round 12 every `!` read
 *   "matched 0 files", and `--fail-on-dead-units` failed load-bearing exclusions.)
 *
 * The boundary plane words its exemption `!` the same way ("exempts none of the
 * N file(s) the rule's from globs match"): one liveness rule for one syntax.
 */
export function globListUnits(
  positivePaths: readonly string[],
  unread: readonly IUnreadFile[],
  globs: readonly string[],
): IGlobListUnits {
  const { include, exclude } = globListParts(globs);
  const measures = measureGlobList(positivePaths, globs);
  const negationsAsWritten = exclude.map((n) => `!${n}`);
  const unreadFilesInScope = unread.filter((u) => !isUnreadDirectory(u) && matchesAny(u.path, include));
  const dead: IDeadGlobUnit[] = [];
  const negations: IGlobNegation[] = [];
  let positiveSize: number | undefined;
  for (const m of measures) {
    if (!m.negation) {
      if (m.effective > 0) continue;
      // Reaching an unread file, or beneath an unlistable directory, that the
      // list keeps in scope is matching something it could not examine — never dead.
      if (unread.some((u) => unreadEntryMatches(u, [m.glob, ...negationsAsWritten]))) continue;
      // Every raw hit here was excluded — count the unread ones too, so a glob
      // whose only match is an excluded over-cap file never reads "matched 0 files".
      const includeRe = globToRegex(m.glob);
      const hits = m.matched + unreadFilesInScope.filter((u) => includeRe.test(u.path)).length;
      dead.push({
        glob: m.glob,
        negation: false,
        matched: hits,
        reason: hits === 0 ? 'matched 0 files' : `matches only files the list's negations exclude (${hits})`,
      });
      continue;
    }
    const pattern = m.glob.slice(1);
    const re = globToRegex(pattern);
    const excludes = m.effective + unreadFilesInScope.filter((u) => re.test(u.path)).length;
    if (excludes > 0) {
      negations.push({ glob: m.glob, excludes });
      continue;
    }
    // A directory whose files were never enumerated may hold what it excludes.
    const mayExcludeUnlisted = unread.some(
      (u) =>
        isUnreadDirectory(u) &&
        include.some((g) => globMayMatchUnder(g, u.path)) &&
        globMayMatchUnder(pattern, u.path),
    );
    if (mayExcludeUnlisted) continue;
    positiveSize ??=
      positivePaths.filter((p) => matchesAny(p, include)).length + unreadFilesInScope.length;
    dead.push({
      glob: m.glob,
      negation: true,
      matched: positiveSize,
      reason: `excludes nothing — none of the ${positiveSize} file(s) the other globs select match it`,
    });
  }
  // Emptied by its own negations: nothing an inclusion glob matched survives,
  // a live negation removed something (so the positive set was not empty), and
  // no unread entry the list keeps in scope could hold a survivor.
  const allExcluded =
    negations.length > 0 &&
    !measures.some((m) => !m.negation && m.effective > 0) &&
    !unread.some((u) => unreadEntryMatches(u, globs));
  return { dead, negations, checked: measures.length, allExcluded, measures };
}

/**
 * {@link globListUnits} over the one reader's POSITIVE walk of `globs`
 * (`readMatchingFiles`, memoised under `withFileReadCache`, so a plane that
 * already read the same list pays nothing twice), read and unread entries
 * alike. For a plane that selects files by a bare list — a generated rule's
 * `generatedGlob`, a doc-reference rule's `files` (pass its `dotDirsNamedBy`,
 * so the walk is the one the rule reads). An extraction source comes through
 * here too, via `sourceGlobUnits`.
 *
 * The engine entry normalises idempotently (round 13): a loaded list is plain
 * strings and passes through; a hand-built `{ pattern, expectEmpty }` entry
 * is judged as its pattern; a MALFORMED entry is never handed to a glob reader
 * and never silently dropped — it is reported as a dead unit naming the problem.
 */
export function readGlobListUnits(
  projectRoot: string,
  rawGlobs: readonly string[],
  excludeDirs: ReadonlySet<string> = new Set(),
  allowDotDirs: ReadonlySet<string> = new Set(),
): IGlobListUnits {
  const normalized = normalizeUnitList(rawGlobs, 'files');
  const globs = normalized.ok ? normalized.value.units : rawGlobs.filter((g): g is string => typeof g === 'string');
  const malformed: IDeadGlobUnit[] = normalized.ok
    ? []
    : unitProblemsOf(normalized.error).map((reason) => ({ glob: '(malformed entry)', negation: false, matched: 0, reason }));
  if (globs.length === 0) return { dead: malformed, negations: [], checked: 0, allExcluded: false };
  const matched = readMatchingFiles(projectRoot, globs, excludeDirs, allowDotDirs);
  const units = globListUnits([...matched.files.keys()], matched.unread, globs);
  return malformed.length > 0 ? { ...units, dead: [...units.dead, ...malformed] } : units;
}

/** The dead units of one glob list — {@link globListUnits}`.dead`. */
export function deadGlobUnits(
  positivePaths: readonly string[],
  unread: readonly IUnreadFile[],
  globs: readonly string[],
): readonly IDeadGlobUnit[] {
  return globListUnits(positivePaths, unread, globs).dead;
}
