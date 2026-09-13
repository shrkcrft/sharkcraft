/**
 * When a flag is refused — which decides the one sentence after the `! …`
 * lines of {@link unknownFlagRefusal} (round 13: one format, three moments).
 */
export enum UnknownFlagRefusalMode {
  /** Refused before anything ran (the pre-run judgement, or a verb's own allow-list). */
  BeforeRun = 'before-run',
  /** The run ignored it and its result is refused — the exit becomes `usageExitFor(path)`. */
  RefusedAfterRun = 'refused-after-run',
  /** The run ignored it; the exit is kept (a found failure, a presentation flag, a non-verdict verb). */
  WarnedAfterRun = 'warned-after-run',
}
