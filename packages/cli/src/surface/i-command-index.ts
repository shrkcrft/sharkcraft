import type { CommandRegistry } from '../command-registry.ts';
import type { ICommandIndexEntry } from './command-index-entry.ts';

/**
 * The complete dispatchable command inventory: every registered handler path,
 * every declared or catalog-documented subverb, and the bootstrap meta flags —
 * joined with the catalog by clean path.
 */
export interface ICommandIndex {
  /** Sorted by path. */
  readonly entries: readonly ICommandIndexEntry[];
  readonly byPath: ReadonlyMap<string, ICommandIndexEntry>;
  /**
   * True when built from a command registry. False only for the registry-less
   * fallback (a direct engine call outside `runCli`), which lists catalog rows
   * whose dispatch is unproven — relabelled `catalog`, never passed off as the
   * dispatch table.
   */
  readonly registryBacked: boolean;
  /** The registry the index was built from, for alias-aware trie descent. */
  readonly registry?: CommandRegistry;
}
