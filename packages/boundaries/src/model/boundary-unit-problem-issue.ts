import type { IBoundaryRuleValidationIssue } from './boundary-rule.ts';

/**
 * One core marker problem (`<listPath>[i]: …`, from `normalizeUnitList`) as a
 * boundary validation issue — field `<listPath>[i]`, message the sentence after
 * it — so every surface prints `forbiddenImports[1]: …` once, in the shape
 * every other boundary issue has (`field: message`).
 */
export function boundaryUnitProblemIssue(problem: string, listPath: string): IBoundaryRuleValidationIssue {
  if (problem.startsWith(`${listPath}[`)) {
    const end = problem.indexOf(']: ');
    if (end > 0) return { field: problem.slice(0, end + 1), message: problem.slice(end + 3) };
  }
  if (problem.startsWith(`${listPath}: `)) return { field: listPath, message: problem.slice(listPath.length + 2) };
  return { field: listPath, message: problem };
}
