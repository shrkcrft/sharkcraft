/** How a markable selector is authored — and so which normaliser reads it. */
export enum UnitEntryForm {
  /** `readonly (string | { pattern, expectEmpty: true, reason? })[]` — `normalizeUnitList`. */
  List = 'list',
  /** `string | { pattern, expectEmpty: true, reason? }` — `normalizeUnitScalar` (`discovery.targetFile`). */
  Scalar = 'scalar',
  /** `Record<string, number | { weight, expectEmpty: true, reason? }>`, the unit is the key — `normalizeUnitMap`. */
  WeightMap = 'weight-map',
}
