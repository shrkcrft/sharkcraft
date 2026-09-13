import type { IUnitMark } from './i-unit-mark.ts';

/**
 * Stamp pack provenance onto marks — called by the loader or merge seam that
 * already knows which pack contributed the element (loadAssetTracked
 * `packageName`, the registration-hint `packageName`, mergePlane
 * `contrib.packageName`, the boundary pack loader). A local element
 * (`packageName` undefined or empty) is returned unchanged. An author can never
 * set it: the entry shape is exact.
 */
export function stampUnitMarks(marks: readonly IUnitMark[], packageName: string | undefined): readonly IUnitMark[] {
  if (packageName === undefined || packageName.length === 0) return marks;
  return marks.map((m) => ({ ...m, packageName }));
}
