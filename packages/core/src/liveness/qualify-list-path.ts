/**
 * A list path qualified by its owner inside a larger settle — `declared` +
 * `files` → `declared.files`. Use it for BOTH sides (the observation's `list`
 * and, via `qualifyUnitMarks`, the marks) so they still match. An empty
 * qualifier returns the path unchanged.
 */
export function qualifyListPath(qualifier: string, listPath: string): string {
  return qualifier.length === 0 ? listPath : `${qualifier}.${listPath}`;
}
