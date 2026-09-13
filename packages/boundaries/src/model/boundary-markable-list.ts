/**
 * The four boundary-rule lists an `expectEmpty` marker may sit in (round 13).
 * Each value is the list's `listPath`: the `list` of every mark the loader
 * records (`normalizeBoundaryRule`) and of every observation the evaluator
 * settles, so a marker always meets the unit it marks. A `from` negation stays
 * in `from` (its unit keeps its `!`); `exceptions[].target` is not markable — a
 * stale exception is an error by design.
 */
export enum BoundaryMarkableList {
  From = 'from',
  ExemptFiles = 'exemptFiles',
  ForbiddenImports = 'forbiddenImports',
  AllowedImports = 'allowedImports',
}
