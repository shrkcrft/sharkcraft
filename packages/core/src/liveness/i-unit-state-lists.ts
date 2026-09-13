/**
 * A rule's non-live units by state, each as its `formatUnitLiveness` line —
 * the optional `units` of a gate envelope rule (`rules[].units`) and of a
 * boundary rule coverage. Built by `unitStateLists`, never by hand.
 */
export interface IUnitStateLists {
  readonly dead: readonly string[];
  readonly intendedEmpty: readonly string[];
  readonly wentLive: readonly string[];
}
