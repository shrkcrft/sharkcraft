import { commandIndexFor } from '../surface/command-index.ts';
import type { ICommandIndex } from '../surface/i-command-index.ts';
import type { IGuardInvocationInput } from './guard-invocation-input.ts';
import { guardInvocation } from './guard-invocation.ts';
import type { IInvocationRejection } from './invocation-rejection.ts';
import { refuseSiblingValveFlags } from './refuse-sibling-valve-flags.ts';
import { refuseUndocumentedFlags, tracksFlagReads } from './unread-flags.ts';
import { walkDeclaredSubverbs } from './walk-declared-subverbs.ts';

/**
 * THE pre-run judgement of one invocation — "would the dispatcher run this?":
 *
 *   1. {@link guardInvocation} — what the handler DECLARES (an unknown
 *      subcommand, a verb-shaped token that is no subverb and no file, a flag
 *      outside a declared set);
 *   2. for a handler without a declared flag set (the post-run detector
 *      tracks it), {@link refuseUndocumentedFlags} — a flag its documentation
 *      does not name is refused before the body runs;
 *   3. round 13 (K1), for the same handlers, {@link refuseSiblingValveFlags} —
 *      a VERDICT-VALVE flag (`--fail-on-dead-units`, `--allow-empty`,
 *      `--min-referenced`, `--fail-on`) the resolved subverb does not document
 *      is refused before the body runs, naming the subverbs that accept it
 *      (`shrk check --fail-on-dead-units` printed the whole sweep, then 3).
 *
 * `runCliInner` calls it before the surface gate and the command body, and the
 * command-string resolver (`resolveCommandString`) calls the same function, so
 * a string the resolver certifies is one the dispatcher runs — two code paths
 * never answer "does this command run?" again (round 11 review CLI-1).
 */
export function judgeInvocation(input: IGuardInvocationInput): IInvocationRejection | undefined {
  const rejection = guardInvocation(input);
  if (rejection !== undefined || input.handler === undefined || input.matchedPath.length === 0) return rejection;
  const handler = input.handler;
  const walk = walkDeclaredSubverbs(handler, input.matchedPath, input.parsed.positional);
  if (!tracksFlagReads(handler, walk)) return undefined;
  // One lazily built index for both refusals — the common run pays nothing.
  let built: ICommandIndex | undefined = input.index;
  const index = (): ICommandIndex => (built ??= commandIndexFor(input.registry));
  return (
    refuseUndocumentedFlags({
      handler,
      matchedPath: input.matchedPath,
      label: walk.path.join(' '),
      parsed: input.parsed,
      index,
    }) ??
    refuseSiblingValveFlags({
      handler,
      matchedPath: input.matchedPath,
      parsed: input.parsed,
      index,
    })
  );
}
