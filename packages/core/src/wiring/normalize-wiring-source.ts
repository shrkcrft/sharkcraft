import { mergeUnitMarks } from '../liveness/merge-unit-marks.ts';
import { normalizeUnitList } from '../liveness/normalize-unit-list.ts';
import { UnitEntryForm } from '../liveness/unit-entry-form.ts';
import { unitProblemsError } from '../liveness/unit-problems-error.ts';
import { unitProblemsOf } from '../liveness/unit-problems-of.ts';
import type { AppErrorImpl } from '../result/errors.ts';
import { err, ok, type Result } from '../result/result.ts';
import type { IWiringSourceInput } from './i-wiring-source-input.ts';
import type { IWiringSource } from './wiring-rule.ts';

/**
 * THE normaliser of one extraction source's markable lists (round 13): `files`
 * (`list: 'files'`) and an `import-edges` target's `to.files` (`list:
 * 'to.files'`) go through core's one parser, `normalizeUnitList`, into the
 * plain string lists every engine reads, and every `{ pattern, expectEmpty:
 * true }` entry into the source's `expectEmptyUnits` ledger.
 *
 * IDEMPOTENT: a loaded source (plain lists) comes back equal, its ledger kept
 * — so the loader, the pack merge seam, `gates try` and the engine entries
 * (`inspectSource`, `runWiring`) may all call it, and a hand-built source
 * never reaches a reader with an object in a glob list. A malformed entry is a
 * `CONFIG_INVALID` error naming every bad entry (`files[1]: …`), never a crash.
 */
export function normalizeWiringSource(
  source: IWiringSource | IWiringSourceInput,
): Result<IWiringSource, AppErrorImpl> {
  const problems: string[] = [];
  const files = source.files !== undefined ? normalizeUnitList(source.files, 'files') : undefined;
  if (files !== undefined && !files.ok) problems.push(...unitProblemsOf(files.error));
  const toFiles = source.to?.files !== undefined ? normalizeUnitList(source.to.files, 'to.files') : undefined;
  if (toFiles !== undefined && !toFiles.ok) problems.push(...unitProblemsOf(toFiles.error));
  if (problems.length > 0) return err(unitProblemsError('files', problems, UnitEntryForm.List));

  const loaded = source as IWiringSource;
  const marks = mergeUnitMarks(
    loaded.expectEmptyUnits,
    files?.ok === true ? files.value.marks : undefined,
    toFiles?.ok === true ? toFiles.value.marks : undefined,
  );
  const { expectEmptyUnits: _ledger, files: _files, to, ...rest } = loaded;
  return ok({
    ...rest,
    ...(files?.ok === true ? { files: files.value.units } : {}),
    ...(to !== undefined ? { to: { ...to, ...(toFiles?.ok === true ? { files: toFiles.value.units } : {}) } } : {}),
    ...(marks.length > 0 ? { expectEmptyUnits: marks } : {}),
  });
}
