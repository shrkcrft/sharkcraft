/**
 * How a command-index entry is dispatched.
 *
 *   - `Trie`    — a registered handler path (`CommandRegistry.listAll()`).
 *   - `Subverb` — dispatched internally by a parent handler on a positional
 *                 (`check wiring`, `graph status`): declared on the handler's
 *                 `subverbs`, or documented by a catalog row under a real
 *                 handler.
 *   - `Meta`    — a bootstrap meta flag handled before dispatch (`--about`,
 *                 `--help`, `--full-help`, `--version`).
 *   - `Catalog` — registry-less fallback only: documented by the catalog, but
 *                 no command registry was available to prove it dispatches.
 */
export enum CommandDispatchKind {
  Trie = 'trie',
  Subverb = 'subverb',
  Meta = 'meta',
  Catalog = 'catalog',
}
