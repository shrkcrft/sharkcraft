/**
 * Tri-state answer to "is this id registered?".
 *
 * A boolean cannot say "I could not look": a lookup known to be unable to
 * answer (the command index was not injected, outside the CLI) collapsed to
 * either `true` (every `shrk …` string "existed") or `false` (every correct
 * command was "missing"). `Unverifiable` is the third answer, and every consumer
 * reports it as NOT VERIFIED — never as a pass and never as a finding.
 */
export enum ReferenceIdStatus {
  Exists = 'exists',
  Missing = 'missing',
  Unverifiable = 'unverifiable',
}
