/**
 * The `acceptedBy` an `expectEmpty` acceptance carries — printed verbatim as
 * `accepted by <value>: …`, so the valve stays visible.
 */
export enum ExpectEmptyAcceptedBy {
  /** A per-unit marker: `{ pattern, expectEmpty: true }` (settle record B). */
  Unit = 'expectEmpty',
  /** The baselines rule-level fence, as authored: `expectEmpty: true` (`RuleEmptiness.AssertedEmptyOutput`). */
  Rule = 'expectEmpty: true',
}
