import { qualifyListPath, qualifyUnitMarks, type IUnitMark } from '@shrkcrft/core';
import { readGlobListUnits } from '../util/dead-glob-units.ts';
import type { IGlobListUnits } from '../util/i-glob-list-units.ts';
import type { IGlobLivenessList } from '../util/i-glob-liveness-list.ts';
import type { IGlobLivenessRequest } from '../util/i-glob-liveness-request.ts';
import type { ILabeledSource } from './i-labeled-source.ts';

/**
 * THE glob lists of a rule's extraction sources as the gate-plane liveness
 * settle reads them (round 13) — every source's `files` and, NEW this round,
 * an `import-edges` source's `to.files` (judged for liveness, so a typo'd fence
 * target is no longer a silent pass, and markable, so a fence to a planned
 * subtree is sayable).
 *
 * Each list is qualified by its side (`declared.files`, `compute.source.to.files`
 * — `qualifyListPath`), and each source's markers the same way
 * (`qualifyUnitMarks`), so one settle spans a rule's every source without two
 * sides' `files` colliding. In a multi-source rule a unit prints `<side>: <glob>`
 * (today's dead-glob selector); `to.files` units print `[<side> ]to.files: <glob>`.
 *
 * `gates coverage` (`buildGateCoverage`), the wiring engine (`runWiring`) and
 * the registration role measurement all build their request here, so the one
 * rule's units read identically on every surface. `unitsOf` lets a caller
 * judge a `files` list off a walk it already did; `to.files` matches resolved
 * import targets, so it is judged off the one reader's own walk of its globs.
 */
export function sourceLivenessRequest(
  projectRoot: string,
  sources: readonly ILabeledSource[],
  excludeDirs: readonly string[] = [],
  subject?: string,
  unitsOf?: (globs: readonly string[]) => IGlobListUnits,
): IGlobLivenessRequest {
  const multi = sources.length > 1;
  const exclude = new Set(excludeDirs);
  const judge = unitsOf ?? ((globs: readonly string[]): IGlobListUnits => readGlobListUnits(projectRoot, globs, exclude));
  const lists: IGlobLivenessList[] = [];
  const marks: IUnitMark[] = [];
  for (const { label, source } of sources) {
    const files = source.files ?? [];
    if (files.length > 0) {
      lists.push({ list: qualifyListPath(label, 'files'), ...(multi ? { label } : {}), globs: files, units: judge(files) });
    }
    const to = source.to?.files ?? [];
    if (to.length > 0) {
      lists.push({
        list: qualifyListPath(label, 'to.files'),
        label: multi ? `${label} to.files` : 'to.files',
        globs: to,
        units: readGlobListUnits(projectRoot, to, exclude),
      });
    }
    marks.push(...qualifyUnitMarks(source.expectEmptyUnits ?? [], label));
  }
  return { ...(subject !== undefined ? { subject } : {}), lists, marks };
}
