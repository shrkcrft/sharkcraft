import { nearestIds } from '../string/nearest-ids.ts';
import { describeEntryValue } from './describe-entry-value.ts';
import { UnitEntryForm } from './unit-entry-form.ts';

const PATTERN_KEYS: readonly string[] = ['pattern', 'expectEmpty', 'reason'];
const WEIGHT_KEYS: readonly string[] = ['weight', 'expectEmpty', 'reason'];
/** Keys an author reaches for instead of `pattern` — named precisely rather than merely "unknown". */
const PATTERN_SYNONYMS: readonly string[] = ['glob', 'path', 'file', 'target', 'specifier', 'unit', 'id', 'name', 'import', 'selector'];
/** Keys an author reaches for instead of `weight`. */
const WEIGHT_SYNONYMS: readonly string[] = ['boost', 'value', 'score'];

/**
 * THE shape rule for one marker object, as problem sentences WITHOUT a
 * location prefix (the caller adds `<listPath>[i]: `). Empty means well formed.
 * `normalizeUnitList`, `normalizeUnitMap` and `normalizeUnitScalar` all call
 * it, so no list re-implements what a marker is.
 *
 * - The unit key (`pattern`, or `weight` in a boost map) must be present:
 *   `pattern` a non-empty string, `weight` a number. A marker with none is "a
 *   marker naming no unit"; a synonym key (`glob`, `path`, …) is named as the
 *   mistake it is — the unit is `pattern` on every list.
 * - `expectEmpty` must be the literal `true`; otherwise write the plain value.
 * - `reason`, when present, must be a non-empty string.
 * - Any other key is refused, with a did-you-mean through the ONE scorer
 *   (`nearestIds`, `@shrkcrft/core`).
 */
export function markerEntryProblems(
  entry: Readonly<Record<string, unknown>>,
  form: UnitEntryForm,
): readonly string[] {
  const weighted = form === UnitEntryForm.WeightMap;
  const unitKey = weighted ? 'weight' : 'pattern';
  const known = weighted ? WEIGHT_KEYS : PATTERN_KEYS;
  const shape = weighted ? '{ weight, expectEmpty: true, reason? }' : '{ pattern, expectEmpty: true, reason? }';
  const plain = weighted ? 'the plain number' : 'the plain string';
  const problems: string[] = [];
  const keys = Object.keys(entry);
  const unitValue = entry[unitKey];
  const synonym =
    unitValue === undefined ? keys.find((k) => (weighted ? WEIGHT_SYNONYMS : PATTERN_SYNONYMS).includes(k)) : undefined;

  if (unitValue === undefined) {
    if (synonym !== undefined) {
      const written = describeEntryValue(entry[synonym]);
      problems.push(
        weighted
          ? `a marker with no weight — write { weight: ${written}, expectEmpty: true } instead of \`${synonym}\``
          : `a marker naming no unit — the unit is named \`pattern\` on every list: write { pattern: ${written}, expectEmpty: true } instead of \`${synonym}\``,
      );
    } else {
      problems.push(
        weighted
          ? 'a marker with no weight — write { weight: <number>, expectEmpty: true }'
          : "a marker naming no unit — write { pattern: '<glob or specifier>', expectEmpty: true }",
      );
    }
  } else if (weighted ? typeof unitValue !== 'number' : typeof unitValue !== 'string' || unitValue.length === 0) {
    problems.push(`${unitKey} must be ${weighted ? 'a number' : 'a non-empty string'} (got ${describeEntryValue(unitValue)})`);
  }

  for (const key of keys) {
    if (known.includes(key) || key === synonym) continue;
    const sameLetters = known.find((k) => k.toLowerCase() === key.toLowerCase());
    const near = sameLetters ?? nearestIds(key, known, 1)[0]?.id;
    problems.push(`unknown key '${key}'${near !== undefined ? ` — did you mean '${near}'?` : ''}; an entry is ${shape}`);
  }

  const expectEmpty = entry['expectEmpty'];
  if (expectEmpty === undefined) {
    problems.push(`an object entry must set expectEmpty: true — write ${plain} otherwise`);
  } else if (expectEmpty !== true) {
    problems.push(`expectEmpty must be the literal true (got ${describeEntryValue(expectEmpty)}) — write ${plain} otherwise`);
  }

  const reason = entry['reason'];
  if (reason !== undefined && (typeof reason !== 'string' || reason.trim().length === 0)) {
    problems.push(`reason must be a non-empty string (got ${describeEntryValue(reason)})`);
  }
  return problems;
}
