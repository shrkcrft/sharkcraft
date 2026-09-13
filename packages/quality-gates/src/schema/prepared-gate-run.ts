import type { IRunGatesOptions } from '../runner/run-gates.ts';

/** A gate run ready to execute: the options, plus the config merge notes to surface (stderr / JSON). */
export interface IPreparedGateRun {
  readonly options: IRunGatesOptions;
  /** Pack-plane merge notes (missing / invalid pack rule files, dropped collisions). */
  readonly planeDiagnostics: readonly string[];
  /** The resolved changeset, when the request was scoped. */
  readonly changedFiles?: readonly string[];
}
