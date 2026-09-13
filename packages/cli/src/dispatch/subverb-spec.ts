import type { PositionalMode } from './positional-mode.ts';

/**
 * One internally-dispatched subverb a handler accepts on `positional[0]`
 * (`shrk check wiring`, `shrk self-config doctor`).
 *
 * Declared on {@link ICommandHandler.subverbs}. The command index lists every
 * declared subverb as a first-class command, so `surface list`, `help` and the
 * command-string resolver see it without a catalog row having to vouch for it.
 */
export interface ISubverbSpec {
  readonly name: string;
  readonly description: string;
  readonly usage: string;
  readonly aliases?: readonly string[];
  /** The complete accepted flag set for this subverb, when declared. */
  readonly flags?: ReadonlySet<string>;
  /** What this subverb's own positional[0] means (see {@link PositionalMode}). */
  readonly positionals?: PositionalMode;
  /**
   * Subverbs this subverb dispatches from ITS next positional (`search tuning
   * list|doctor|explain`, `onboard adopt status|…`). Indexed as first-class
   * commands and walked by the dispatcher guard exactly like the top level.
   */
  readonly subverbs?: readonly ISubverbSpec[];
}
