import type { ICommandResolution } from './i-command-resolution.ts';
import type { ICommandResolveOptions } from './i-command-resolve-options.ts';

/**
 * Inputs `warmReferenceRegistries` cannot derive from the inspection because
 * they live ABOVE this layer.
 *
 * `commandResolver` is the CLI's command-string resolver, built from the live
 * command index. Without it, a `command` reference is `Unverifiable` — reported
 * as NOT VERIFIED, never as a pass. The inspector cannot import the CLI (layer
 * order), so the answer is injected exactly like `runDoctor`'s
 * `graphDivergence`.
 */
export interface IReferenceWarmOptions {
  /**
   * `options.assumeShrk` asks for the command-REFERENCE reading (a bare
   * `doctor` is `shrk doctor`) — see {@link ICommandResolveOptions}. A resolver
   * that ignores it still type-checks; the CLI's honours it.
   */
  readonly commandResolver?: (raw: string, options?: ICommandResolveOptions) => ICommandResolution;
}
