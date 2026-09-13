/**
 * Which asset kind declared a reference the staleness sweep visited.
 *
 * Knowledge entries were the only kind the sweep enumerated; boundary rules and
 * policy checks describe directories and packages too, and a stale one was
 * reported by nothing. Each kind is counted separately, so a reader can tell
 * whether a kind was in the sweep at all.
 */
export enum ReferenceAssetKind {
  Knowledge = 'knowledge',
  BoundaryRule = 'boundary-rule',
  Policy = 'policy',
}
