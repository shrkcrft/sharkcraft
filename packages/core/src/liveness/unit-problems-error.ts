import { AppErrorImpl, ERROR_CODES } from '../result/errors.ts';
import { UnitEntryForm } from './unit-entry-form.ts';

/**
 * The one error a malformed markable selector produces: `CONFIG_INVALID`, its
 * message the first problem (`+N more`), and EVERY problem in
 * `details.problems` (each `<listPath>[i]: …`) — read them back with
 * `unitProblemsOf`. A zod refinement, a boundary validator and a pack loader
 * all surface the same sentences.
 */
export function unitProblemsError(
  listPath: string,
  problems: readonly string[],
  form: UnitEntryForm,
): AppErrorImpl {
  const first = problems[0] ?? `${listPath}: malformed entry`;
  const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : '';
  return new AppErrorImpl(ERROR_CODES.CONFIG_INVALID, `${first}${more}`, {
    details: { listPath, problems: [...problems] },
    suggestion:
      form === UnitEntryForm.WeightMap
        ? 'write each value as a number, or as { weight, expectEmpty: true, reason? } to assert that its target does not exist yet'
        : 'write each entry as a plain string, or as { pattern, expectEmpty: true, reason? } to assert that its target does not exist yet',
  });
}
