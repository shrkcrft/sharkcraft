/**
 * A unit dead by its SHAPE, proved without reading a file (round 12): it can
 * never go live, so an `expectEmpty` marker on it is refused at load and
 * ignored by the settle. Values match the boundary plane's published `cause`.
 */
export enum UnitDeadCause {
  /** An `importPatternDefect` — a `!`, an empty pattern, a trailing `/` under package semantics. */
  Defect = 'defect',
  /** An allowance a forbidden sibling covers: forbidden is checked first, so it can never admit an import. */
  Shadowed = 'shadowed',
}
