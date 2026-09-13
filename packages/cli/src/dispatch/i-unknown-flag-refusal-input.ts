import type { UnknownFlagRefusalMode } from './unknown-flag-refusal-mode.ts';

/** What {@link unknownFlagRefusal} needs to word one refused invocation. */
export interface IUnknownFlagRefusalInput {
  /** When the refusal happens (default {@link UnknownFlagRefusalMode.BeforeRun}). */
  readonly mode?: UnknownFlagRefusalMode;
  /**
   * Per flag key, the OTHER command paths whose documentation names it (a
   * sibling subverb) — worded `— only \`shrk check boundaries\` documents it`.
   */
  readonly documentedOn?: Readonly<Record<string, readonly string[]>>;
  /** The walked command path (`gates check`, `self-config doctor`) — what the message and help pointer name. */
  readonly label: string;
  /** The parsed flag keys being refused, in the order they were supplied. */
  readonly flags: readonly string[];
  /** Flag names the command documents — the did-you-mean candidates. */
  readonly known: readonly string[];
  /**
   * The command's complete DECLARED flag set, when it declares one (`gates
   * check`, `check boundaries`) — printed as one `Accepts:` line. Absent for a
   * command judged by its documentation.
   */
  readonly accepts?: readonly string[];
  /** The argv the flags were parsed from — to name each flag as TYPED (`-x` vs `--x`). */
  readonly argv?: readonly string[];
  /** The exit the refusal returns: `usageExitFor(label)` — 3 on a verdict verb, 2 elsewhere. */
  readonly exitCode: number;
}
