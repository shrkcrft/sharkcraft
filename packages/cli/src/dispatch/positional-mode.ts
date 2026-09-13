/**
 * What a handler's `positional[0]` means when it is NOT one of its subverbs.
 *
 * Declared opt-in on {@link ICommandHandler.positionals}; `undefined` means
 * legacy (unchecked). The command index and the command-string resolver read
 * it: only a handler that declares `None` can prove an unknown bare token is an
 * unknown subverb rather than a legitimate free positional.
 *
 *   - `None` — every positional[0] must be a declared subverb.
 *   - `Free` — any other token is a free positional (a query, an id).
 *   - `Path` — any other token is a file path.
 */
export enum PositionalMode {
  None = 'none',
  Free = 'free',
  Path = 'path',
}
