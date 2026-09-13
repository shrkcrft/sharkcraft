import type { ICommandHandler, ParsedArgs } from '../command-registry.ts';
import { usageExitFor } from '../exit-codes.ts';
import type { ICommandIndex } from '../surface/i-command-index.ts';
import { GLOBAL_FLAGS } from './global-flags.ts';
import type { IInvocationRejection } from './invocation-rejection.ts';
import { unknownFlagRefusal } from './unknown-flag-refusal.ts';
import { UnknownFlagRefusalMode } from './unknown-flag-refusal-mode.ts';
import {
  documentedFlagNames,
  invocationFlagDocumentation,
  isFlagDocumented,
  siblingsDocumenting,
} from './unread-flags.ts';
import { VerdictValveFlag } from './verdict-valve-flag.ts';
import { walkDeclaredSubverbs } from './walk-declared-subverbs.ts';

const VALVE_FLAGS: ReadonlySet<string> = new Set<string>(Object.values(VerdictValveFlag));

/**
 * THE pre-run refusal of a VERDICT-VALVE flag ({@link VerdictValveFlag}) the
 * resolved subverb does not document (round 13, K1) — part of the one
 * `judgeInvocation`, so the dispatcher and the command-string resolver refuse
 * the same string.
 *
 * `shrk check --fail-on-dead-units` ran the whole sweep and only then exited 3
 * (the post-run judgement of a sibling-only flag): only `check boundaries`
 * documents the flag. A valve changes what the exit MEANS, so a run that
 * ignored one must not print a verdict first. The invocation's documentation
 * is {@link invocationFlagDocumentation} — its walked usages, the index entries
 * its path passes through and the handler's `UNDOCUMENTED_FLAG_READS` row — and
 * the message names the subverbs that do accept the flag. Exits
 * `usageExitFor(path)`: 3 on a verdict verb, 2 elsewhere.
 *
 * The group-level refusal (`refuseUndocumentedFlags`) has already refused a
 * flag no documentation of the group names, so every flag judged here is one
 * a SIBLING documents. The index is built only when the walked usages leave a
 * supplied valve flag unexplained.
 */
export function refuseSiblingValveFlags(input: {
  readonly handler: ICommandHandler;
  readonly matchedPath: readonly string[];
  readonly parsed: ParsedArgs;
  readonly index: () => ICommandIndex;
}): IInvocationRejection | undefined {
  const supplied = [...input.parsed.flags.keys()].filter((key) => VALVE_FLAGS.has(key) && !GLOBAL_FLAGS.has(key));
  if (supplied.length === 0) return undefined;
  const walk = walkDeclaredSubverbs(input.handler, input.matchedPath, input.parsed.positional);
  // The cheap path: the handler's own usage and the walked level's usage.
  const own = [input.handler.usage, walk.level.usage];
  const unsure = supplied.filter((key) => !isFlagDocumented(key, own));
  if (unsure.length === 0) return undefined;
  const index = input.index();
  const docs = invocationFlagDocumentation({
    handler: input.handler,
    matchedPath: input.matchedPath,
    positional: input.parsed.positional,
    index,
  });
  const refused = unsure.filter((key) => !isFlagDocumented(key, docs));
  if (refused.length === 0) return undefined;
  const label = walk.path.join(' ');
  const documentedOn: Record<string, readonly string[]> = {};
  for (const key of refused) {
    const owners = siblingsDocumenting(key, input.matchedPath, walk.path, index);
    if (owners.length > 0) documentedOn[key] = owners;
  }
  return unknownFlagRefusal({
    label,
    flags: refused,
    known: documentedFlagNames(docs),
    documentedOn,
    ...(input.parsed.argv !== undefined ? { argv: input.parsed.argv } : {}),
    exitCode: usageExitFor(label),
    mode: UnknownFlagRefusalMode.BeforeRun,
  });
}
