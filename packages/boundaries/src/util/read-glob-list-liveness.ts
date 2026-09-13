import type { ISettledUnitLiveness, IUnitMark } from '@shrkcrft/core';
import { readGlobListUnits } from './dead-glob-units.ts';
import type { IGlobListUnits } from './i-glob-list-units.ts';
import { settleGlobLists } from './settle-glob-lists.ts';

/**
 * ONE glob list, judged off the one reader's positive walk
 * (`readGlobListUnits`, memoised under `withFileReadCache`) and settled with
 * its markers (`settleGlobLists`) — for an engine that selects files by a bare
 * list and must decide its rule's emptiness: a registry's / idiom role's /
 * extractor baseline's source `files`, a generated rule's `generatedGlob`, a
 * doc-reference rule's `files` (pass its `dotDirsNamedBy`, so the walk is the
 * one the rule reads). `marks` are the list's own (`list` equal to `list`).
 */
export function readGlobListLiveness(
  projectRoot: string,
  list: string,
  globs: readonly string[],
  marks: readonly IUnitMark[],
  options: {
    readonly subject?: string;
    readonly excludeDirs?: ReadonlySet<string>;
    readonly allowDotDirs?: ReadonlySet<string>;
  } = {},
): { readonly units: IGlobListUnits; readonly liveness: ISettledUnitLiveness } {
  const units = readGlobListUnits(projectRoot, globs, options.excludeDirs, options.allowDotDirs);
  const liveness = settleGlobLists({
    ...(options.subject !== undefined ? { subject: options.subject } : {}),
    lists: [{ list, globs, units }],
    marks: marks.filter((m) => m.list === list),
  });
  return { units, liveness };
}
