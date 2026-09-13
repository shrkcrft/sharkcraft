import type { ISettledUnitLiveness } from './i-settled-unit-liveness.ts';

/** What `settleRuleEmptiness` needs to decide what a rule that yielded nothing IS. */
export interface IRuleEmptinessInput {
  /** The rule id — the `subject` of a coverage record this returns. */
  readonly subject?: string;
  /** What the rule's primary selector yields, plural (`files`, `content units`, `ids`, `entries`). */
  readonly unitLabel: string;
  /** Files the PRIMARY list selected (after its own negations). */
  readonly filesMatched: number;
  /** Units the rule extracted from them (ids / tokens / content units / edges / entries) — for a ceiling, the extractor's unit count. */
  readonly unitsMatched: number;
  /** True when a file the primary selector matched was not read. */
  readonly unread: boolean;
  /** True when the primary list's own negations excluded every file its inclusion globs matched (`IGlobListUnits.allExcluded`). */
  readonly emptiedByNegations?: boolean;
  /**
   * The rule's settled units (`settleUnitLiveness`). REQUIRED: IntendedEmpty is
   * granted only from it, and a fence's inputs are judged from it. A rule with
   * no markable list passes a settle over no observations.
   */
  readonly liveness: ISettledUnitLiveness;
  /** Which `list` values of {@link liveness} form the PRIMARY list (`['declared.files']`). Omitted: every list in it. */
  readonly primaryLists?: readonly string[];
  /** The baselines rule-level fence — pass `ruleAssertsEmptyOutput(rule)`. */
  readonly assertsEmptyOutput?: boolean;
  /** THE failOnEmpty authority's answer — pass `failsWhenEmpty(rule)` (`@shrkcrft/core`), never an inline default. */
  readonly failOnEmpty: boolean;
  /** The plane's words for "the primary list matched no file" (`0 files matched the source globs`). */
  readonly noFilesReason: string;
  /** The plane's words for "files matched, 0 units came out" (`0 ids extracted from the source side`). */
  readonly noUnitsReason: string;
  /** The plane's words when {@link emptiedByNegations} (default: `matched nothing — its own negations exclude …`). */
  readonly emptiedReason?: string;
}
