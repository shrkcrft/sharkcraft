/**
 * WHY a reference check did not pass — additive to its `outcome`.
 *
 * `outcome` (ok / stale / missing / unknown) is kept for back-compat, but it
 * conflated unrelated failures: a missing FILE reference read `stale` while a
 * symbol pinned to a missing file read `missing`, and nothing separated "the
 * path is gone" from "the path is there but the thing inside it is not". Each
 * failure mode can be failed on separately (`--fail-on path-missing`).
 */
export enum ReferenceFailure {
  /** The file / directory (or a symbol's pinned file) does not exist. */
  PathMissing = 'path-missing',
  /** The path exists, but the symbol / member it pins does not. */
  AnchorMissing = 'anchor-missing',
  /** The target exists but no longer `contains` / `matches` what the asset claims. */
  ContentMismatch = 'content-mismatch',
  /** A declared `count` re-derived to a different number. */
  CountMismatch = 'count-mismatch',
  /** An id-keyed reference (template, playbook, policy, …) is not registered. */
  IdUnregistered = 'id-unregistered',
  /** The check could not run — nothing was proved either way. */
  Unverifiable = 'unverifiable',
  /**
   * The reference itself is malformed — a kind outside the vocabulary, or the
   * field its kind cannot be checked without (`path`, `symbol`, `id`) is
   * missing. Nothing was checked, and unlike `unverifiable` (a well-formed
   * `url` the check deliberately never fetches) the author can fix it.
   */
  Malformed = 'malformed',
}
