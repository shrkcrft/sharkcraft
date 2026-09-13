import type { ICommandHandler } from '../command-registry.ts';
import type { IDeclaredInvocation } from './i-declared-invocation.ts';

/**
 * Walk `positional` through the subverbs `handler` DECLARES (nested ones
 * included): each positional naming a declared subverb (or one of its aliases)
 * descends one level; the first that does not stops the walk. The declared flag
 * sets met on the way are unioned — `graph` declares none, `graph cycles`
 * declares its own, so `graph cycles --x` is judged against the cycles set.
 *
 * Pure; the dispatcher guard, the help topic and the post-run detector all
 * read the same walk, so they cannot disagree about which subverb ran.
 */
export function walkDeclaredSubverbs(
  handler: ICommandHandler,
  matchedPath: readonly string[],
  positional: readonly string[],
): IDeclaredInvocation {
  const path = [...matchedPath];
  let level: IDeclaredInvocation['level'] = handler;
  let flags: Set<string> | undefined = handler.flags ? new Set(handler.flags) : undefined;
  let consumed = 0;
  while (consumed < positional.length) {
    const token = positional[consumed]!;
    const match = (level.subverbs ?? []).find(
      (s) => s.name === token || (s.aliases ?? []).includes(token),
    );
    if (!match) break;
    path.push(match.name);
    level = match;
    if (match.flags) flags = new Set([...(flags ?? []), ...match.flags]);
    consumed += 1;
  }
  return { path, level, consumed, ...(flags ? { flags } : {}) };
}
