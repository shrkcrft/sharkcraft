import type { CommandRegistry, ICommandHandler, ParsedArgs } from '../command-registry.ts';
import type { ICommandIndex } from '../surface/i-command-index.ts';

/** What the dispatcher knows about one invocation when it asks the guard. */
export interface IGuardInvocationInput {
  /** The registry this run dispatches from (the command index is built from it). */
  readonly registry: CommandRegistry;
  /** The handler at the deepest matched trie path; `undefined` for a pure command group. */
  readonly handler: ICommandHandler | undefined;
  /** The canonical trie path the descent matched. */
  readonly matchedPath: readonly string[];
  /** The trie children at the matched node — a mixed-mode parent's or a group's verbs. */
  readonly trieChildren: readonly string[];
  /** The handler's parsed argv (the leftover tokens). */
  readonly parsed: ParsedArgs;
  /**
   * Where a `PositionalMode.Path` token is looked up on disk. Absent → no token
   * names a file: the disk-free reading the command-string resolver uses when it
   * was given no project root.
   */
  readonly cwd?: string;
  /** The command index of `registry`, when the caller already holds one (else built lazily, memoised per registry). */
  readonly index?: ICommandIndex;
}
