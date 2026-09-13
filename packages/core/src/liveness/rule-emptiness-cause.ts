/** Why a rule settled `RuleEmptiness.Stale`. */
export enum RuleEmptinessCause {
  /** The primary list matched no file, and not every inclusion unit is intended-empty. */
  NoFiles = 'no-files',
  /** Files matched, but 0 ids / tokens / content units came out of them — never assertable. */
  NoUnits = 'no-units',
  /** A baselines `expectEmpty` fence whose input selector is dead: the empty output proves nothing. */
  DeadInput = 'dead-input',
}
