/**
 * Which entries of a list a `MarkableUnitList` spec covers. Most lists weigh
 * every entry alike (`Any`); the boundary `from` list weighs its inclusion
 * globs (Coverage) and its `!` exemptions (Advisory) differently, so it has a
 * spec per polarity.
 */
export enum UnitPolarity {
  Any = 'any',
  /** Entries without a leading `!`. */
  Inclusion = 'inclusion',
  /** `!` entries (kept verbatim in `pattern` / the unit). */
  Negation = 'negation',
}
