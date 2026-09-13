/**
 * How one declared cross-reference id resolved.
 *
 * `Unverified` is its own outcome, never folded into either of the others: an
 * id checked against a registry that was never warmed (or is empty) could not
 * be looked up, and reporting it `Dangling` is how a correct id gets flagged,
 * while reporting it `Ok` is how a dead one ships.
 */
export enum DeclaredXrefStatus {
  /** Resolves in a kind the field accepts. */
  Ok = 'ok',
  /** Resolves in NO registry. */
  Dangling = 'dangling',
  /** Resolves, but only in kinds the field does not accept (a template id in `relatedRules`). */
  WrongKind = 'wrong-kind',
  /** Could not be decided — an accepted registry was not warmed, or is empty. NOT VERIFIED. */
  Unverified = 'unverified',
}
