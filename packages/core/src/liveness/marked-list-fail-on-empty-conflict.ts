import type { IUnitList } from './i-unit-list.ts';

/**
 * The one load-time conflict between a marker ledger and `failOnEmpty`, or
 * `undefined`: an explicit `failOnEmpty: true` together with EVERY inclusion
 * unit of the rule's primary list marked. Every such unit asserts "nothing
 * here yet", so the rule's empty result is intended — while `failOnEmpty: true`
 * asserts that an empty result is a failure. Partial marking is legal; the
 * DEFAULT failOnEmpty of an error rule is not a conflict (the rule settles
 * `IntendedEmpty`, accepted).
 *
 * Returns the problem sentence; the caller maps it onto its field path.
 */
export function markedListFailOnEmptyConflict(
  list: IUnitList,
  listPath: string,
  failOnEmpty: boolean | undefined,
): string | undefined {
  if (failOnEmpty !== true) return undefined;
  const inclusion = list.units.filter((u) => !u.startsWith('!'));
  if (inclusion.length === 0) return undefined;
  const marked = new Set(list.marks.filter((m) => m.list === listPath).map((m) => m.unit));
  if (!inclusion.every((u) => marked.has(u))) return undefined;
  return `every inclusion unit of \`${listPath}\` is asserted empty (expectEmpty), so the rule's empty result is intended — failOnEmpty: true asserts the opposite; drop one of them`;
}
