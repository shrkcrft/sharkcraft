import type { CommandAudience, ICommandCatalogEntry } from '../commands/command-catalog.ts';
import type { PositionalMode } from '../dispatch/positional-mode.ts';
import type { CommandDispatchKind } from './command-dispatch-kind.ts';

/**
 * One dispatchable command — a row of the command index.
 *
 * The index is the ONE answer to "does this command exist, what does it do,
 * who is it for": `surface list`, `help`, `commands doctor`, the surface gate
 * and the command-string resolver all read it.
 */
export interface ICommandIndexEntry {
  /** Clean command path, space-joined (`knowledge stale-check`, `check wiring`). */
  readonly path: string;
  readonly tokens: readonly string[];
  readonly dispatch: CommandDispatchKind;
  /** Catalog description ?? declared-subverb description ?? handler description. */
  readonly description: string;
  /** Declared-subverb usage ?? handler usage (catalog-only subverbs have none). */
  readonly usage?: string;
  /** True when a COMMAND_CATALOG row documents this path. */
  readonly catalogued: boolean;
  /** The base catalog row (the one whose `command` is exactly the clean path, else the first). */
  readonly catalogEntry?: ICommandCatalogEntry;
  /**
   * Catalog rows folded into this entry because they only add flags or
   * placeholders (`architecture violations --changed-only`, `impact <input>`).
   * Full `command` strings, sorted.
   */
  readonly variants: readonly string[];
  /** Catalog aliases plus registry alias spellings of this path. */
  readonly aliases: readonly string[];
  readonly audience: readonly CommandAudience[];
  /** For `Subverb`: the handler path that dispatches it. */
  readonly parent?: string;
  /** For `Subverb`: declared on the handler (`subverbs`) rather than only documented by the catalog. */
  readonly declared?: boolean;
  /** What a non-subverb positional[0] means for this command, when declared. */
  readonly positionals?: PositionalMode;
}
