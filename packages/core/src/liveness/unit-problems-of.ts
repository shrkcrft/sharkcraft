import type { AppError } from '../result/errors.ts';

/**
 * The problem sentences behind a normaliser's error (`details.problems`, each
 * `<listPath>[i]: …`), or the error message when it carries none.
 */
export function unitProblemsOf(error: AppError): readonly string[] {
  const problems = error.details?.['problems'];
  if (Array.isArray(problems)) {
    const out = problems.filter((p): p is string => typeof p === 'string');
    if (out.length > 0) return out;
  }
  return [error.message];
}
