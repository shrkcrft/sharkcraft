/**
 * One `expectEmpty` marker after normalisation — the ledger every LOADED rule,
 * source or asset carries as `expectEmptyUnits` next to its PLAIN string list.
 * Readers of the list never see an object; the one settle
 * (`settleUnitLiveness`) is the only consumer of the ledger.
 */
export interface IUnitMark {
  /**
   * The list the unit belongs to: the `listPath` the loader passed to
   * `normalizeUnitList` / `normalizeUnitMap` / `normalizeUnitScalar`
   * (`forbiddenImports`, `files`, `to.files`, `discovery.targetFile`,
   * `taskHints[0].boostIds`), relative to the object that carries the ledger.
   * A reporter observing the unit uses the SAME string — qualified with
   * `qualifyListPath` when one settle spans several owners.
   */
  readonly list: string;
  /** The unit as written: the pattern (a negation keeps its `!`) or the boost-map key. */
  readonly unit: string;
  /** The author's reason, when one was given. */
  readonly reason?: string;
  /**
   * The pack that contributed the marker. STAMPED by the loader or merge seam
   * from provenance it already holds (`stampUnitMarks`); an author cannot write
   * it, because the entry shape is exact. A pack marker that went live is
   * reported as INFO and never fails (`selectorUnitFails`) — the consumer
   * cannot edit it.
   */
  readonly packageName?: string;
}
