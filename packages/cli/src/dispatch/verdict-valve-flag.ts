/**
 * The VERDICT-VALVE flags (round 13, K1) — the closed set of flags that change
 * what a verdict verb's exit MEANS: a gap it accepts (`--allow-empty`,
 * `--min-referenced`) or a unit it fails on (`--fail-on-dead-units`,
 * `--fail-on`). None is a global flag.
 *
 * A valve flag the resolved subverb does not document is refused BEFORE the run
 * (`refuseSiblingValveFlags`, inside the one `judgeInvocation`): a run that
 * ignored a valve reads as the verb's own answer — `shrk check
 * --fail-on-dead-units` printed the whole sweep and only then exited 3. Every
 * other sibling-documented flag keeps the post-run judgement, because whether
 * a subverb's code reads a shared option is not static knowledge; a valve is
 * the one kind whose reader is always the documenting verb.
 */
export enum VerdictValveFlag {
  FailOnDeadUnits = 'fail-on-dead-units',
  AllowEmpty = 'allow-empty',
  MinReferenced = 'min-referenced',
  FailOn = 'fail-on',
}
