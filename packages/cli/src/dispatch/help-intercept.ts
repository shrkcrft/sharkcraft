import type { ICommandIndex } from '../surface/i-command-index.ts';

/**
 * `--help` / `-h` ANYWHERE in the leftover tokens — after a subverb, a
 * positional or another flag — up to the POSIX `--` sentinel. Tokens after
 * `--` are literal positionals (`shrk languages run -- --help` passes `--help`
 * through untouched).
 *
 * Before round 11 only a LEADING `--help` was intercepted, so on every
 * internally-dispatched subverb the command body ran instead: `report site
 * --help` wrote twelve HTML files and `graph index --help` built the store.
 */
export function wantsHelp(tokens: readonly string[]): boolean {
  for (const token of tokens) {
    if (token === '--') return false;
    if (token === '--help' || token === '-h') return true;
  }
  return false;
}

/**
 * The help topic for an intercepted invocation: the matched trie path,
 * extended through the leading bare tokens to the LONGEST path the command
 * index knows (`graph importers foo --help` → `graph importers`;
 * `bundle replay scaffold github-actions --help` → that whole row). An alias
 * spelling resolves to its canonical entry. A token the index does not know
 * leaves the topic at the deepest known path — help never invents one.
 */
export function helpTopicFor(
  index: ICommandIndex,
  matchedPath: readonly string[],
  leftover: readonly string[],
): string[] {
  const bare: string[] = [];
  for (const token of leftover) {
    if (token.startsWith('-')) break;
    bare.push(token);
  }
  for (let k = bare.length; k >= 1; k -= 1) {
    const candidate = [...matchedPath, ...bare.slice(0, k)].join(' ');
    const entry =
      index.byPath.get(candidate) ?? index.entries.find((e) => e.aliases.includes(candidate));
    if (entry) return [...entry.tokens];
  }
  return [...matchedPath];
}
