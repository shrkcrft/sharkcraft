import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { firstUnknownFlag } from '../command-registry.ts';
import { usageExitFor } from '../exit-codes.ts';
import { commandIndexFor, subverbNamesOf } from '../surface/command-index.ts';
import type { ICommandIndex } from '../surface/i-command-index.ts';
import { closestMatches } from './closest-match.ts';
import { GLOBAL_FLAGS, IMPLICIT_FLAGS } from './global-flags.ts';
import type { IGuardInvocationInput } from './guard-invocation-input.ts';
import type { IInvocationRejection } from './invocation-rejection.ts';
import { InvocationRejectionKind } from './invocation-rejection-kind.ts';
import { PositionalMode } from './positional-mode.ts';
import type { ISubverbSpec } from './subverb-spec.ts';
import { unknownFlagRefusal } from './unknown-flag-refusal.ts';
import { walkDeclaredSubverbs } from './walk-declared-subverbs.ts';

/**
 * THE pre-run invocation guard (round 11 §5.2): cheap, no inspection, runs
 * after the help intercept and before the surface gate and the command body.
 *
 * Before it, a wrong command ran something else and exited 0 —
 * `shrk check rules --tag auth` printed a full green sweep, `shrk templates
 * lst` printed group help at exit 0, `shrk api-diff status` reported a missing
 * baseline FILE named `status`. The guard judges only what a handler DECLARES,
 * so a legitimate free positional (`task "add a thing"`) is never rejected:
 *
 *   - a pure command group + a bare token                → unknown subcommand;
 *   - `positionals: None` + a token that names no subverb → unknown subcommand
 *     (the closest match, and "`rules` is a command of its own" when it is);
 *   - `positionals: Path` + a VERB-SHAPED token that is neither a subverb nor
 *     an existing file → "has no `status` verb, and no file named `status`
 *     exists", with the sibling commands that do have that verb;
 *   - declared `flags` → any other flag (the global flags excepted).
 *
 * Every rejection exits `usageExitFor(path)` — 3 on a verdict verb, 2
 * elsewhere — and never 0. The dispatcher calls it through
 * `judgeInvocation`, which adds the undocumented-flag refusal; the
 * command-string resolver calls the same function.
 */
export function guardInvocation(input: IGuardInvocationInput): IInvocationRejection | undefined {
  const { handler, matchedPath, parsed } = input;
  if (matchedPath.length === 0) return undefined;
  if (!handler) {
    const token = parsed.positional[0];
    if (token === undefined) return undefined;
    return unknownSubcommand(input, matchedPath, token, input.trieChildren);
  }
  const walk = walkDeclaredSubverbs(handler, matchedPath, parsed.positional);
  const token = parsed.positional[walk.consumed];
  if (token !== undefined) {
    const specs = walk.level.subverbs ?? [];
    if (walk.level.positionals === PositionalMode.None) {
      const names = [...specs.map((s) => s.name), ...(walk.consumed === 0 ? input.trieChildren : [])];
      return unknownSubcommand(input, walk.path, token, names);
    }
    if (walk.level.positionals === PositionalMode.Path && isVerbShaped(token) && !namesAFile(input, token)) {
      return noSuchVerbOrFile(input, walk.path, token, specs);
    }
  }
  if (walk.flags) {
    const bad = firstUnknownFlag(parsed, new Set([...walk.flags, ...GLOBAL_FLAGS]));
    if (bad !== undefined) return unknownFlag(walk.path, bad, walk.flags, parsed.argv);
  }
  return undefined;
}

const VERB_SHAPED = /^[a-z][a-z0-9-]*$/;

/**
 * A token that reads as a VERB, not a path: lowercase kebab starting with a
 * letter — no `.`, `/`, `\`, `:`, `{`, `=` or uppercase. Inline JSON (`{…}`),
 * `-` (stdin) and any real path fail it, so the Path rule never blocks them.
 */
export function isVerbShaped(token: string): boolean {
  return VERB_SHAPED.test(token);
}

function indexOf(input: IGuardInvocationInput): ICommandIndex {
  return input.index ?? commandIndexFor(input.registry);
}

/** An existing file or directory under the invocation's cwd (none without a cwd). */
function namesAFile(input: IGuardInvocationInput, token: string): boolean {
  return input.cwd !== undefined && existsSync(nodePath.resolve(input.cwd, token));
}

function subcommandList(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/** The closest real subcommands of `label`, as full invocations. */
function closestSubcommands(label: string, token: string, names: readonly string[]): string[] {
  return closestMatches(token, names, 3).map((c) => `shrk ${label} ${c}`);
}

function didYouMean(closest: readonly string[]): string {
  if (closest.length === 0) return '';
  return `  Did you mean ${closest.map((c) => `\`${c}\``).join(' or ')}?\n`;
}

/** "`rules` is a command of its own: shrk rules add|doctor|…" — when it is. */
function ownCommandHint(input: IGuardInvocationInput, token: string): string {
  const own = input.registry.resolve([token]);
  const head = own.matchedPath[0];
  if (own.matchedPath.length !== 1 || head === undefined) return '';
  const subs = subverbNamesOf(indexOf(input), head);
  const shown = subs.slice(0, 6).join('|');
  const tail = subs.length === 0 ? '' : ` ${shown}${subs.length > 6 ? '|…' : ''}`;
  return `  \`${token}\` is a command of its own: shrk ${head}${tail} — see \`shrk help ${head}\`.\n`;
}

/** "`status` is a verb of: shrk graph status, shrk context status, …" — from the index. */
function siblingVerbHint(input: IGuardInvocationInput, token: string): string {
  const owners = indexOf(input)
    .entries.filter((e) => e.tokens.length > 1 && e.tokens[e.tokens.length - 1] === token)
    .map((e) => `shrk ${e.path}`);
  if (owners.length === 0) return '';
  const shown = owners.slice(0, 6);
  const more = owners.length > shown.length ? ` (+${owners.length - shown.length} more)` : '';
  return `  \`${token}\` is a verb of: ${shown.join(', ')}${more}\n`;
}

/**
 * Subverbs that were REMOVED, keyed `<path> <token>`, and the command that
 * replaced each — named in place of the own-command hint, so `commands explain
 * doctor` never points at `shrk explain` (the knowledge / rule topic search) as
 * if it described a command.
 */
const RETIRED_SUBVERBS: ReadonlyMap<string, string> = new Map([
  ['commands suggest', 'shrk commands search "<partial>"'],
  ['commands explain', 'shrk help <cmd>'],
]);

function unknownSubcommand(
  input: IGuardInvocationInput,
  path: readonly string[],
  token: string,
  names: readonly string[],
): IInvocationRejection {
  const label = path.join(' ');
  const subs = subcommandList(names);
  const closest = closestSubcommands(label, token, subs);
  let message = `\`shrk ${label}\` has no \`${token}\` subcommand.\n`;
  if (subs.length > 0) message += `  Subcommands: ${subs.join(', ')}\n`;
  message += didYouMean(closest);
  const replacement = RETIRED_SUBVERBS.get(`${label} ${token}`);
  message +=
    replacement !== undefined
      ? `  \`${token}\` was removed from \`shrk ${label}\` — use \`${replacement}\`.\n`
      : ownCommandHint(input, token);
  message += `  Run \`shrk help ${label}\` for usage.\n`;
  return {
    message,
    exitCode: usageExitFor(label),
    kind: InvocationRejectionKind.UnknownSubcommand,
    ...(closest.length > 0 ? { closest } : {}),
  };
}

function noSuchVerbOrFile(
  input: IGuardInvocationInput,
  path: readonly string[],
  token: string,
  specs: readonly ISubverbSpec[],
): IInvocationRejection {
  const label = path.join(' ');
  const closest = closestSubcommands(label, token, specs.map((s) => s.name));
  let message = `\`shrk ${label}\` has no \`${token}\` verb, and no file named \`${token}\` exists.\n`;
  if (specs.length > 0) {
    message += '  Subcommands:\n';
    for (const s of specs) message += `    ${s.name} — ${(s.usage.split('\n')[0] ?? '').trim()}\n`;
  }
  message += didYouMean(closest);
  message += siblingVerbHint(input, token);
  message += `  Run \`shrk help ${label}\` for usage.\n`;
  return {
    message,
    exitCode: usageExitFor(label),
    kind: InvocationRejectionKind.NoSuchVerbOrFile,
    ...(closest.length > 0 ? { closest } : {}),
  };
}

/**
 * A flag outside a DECLARED set, worded by THE one refusal format (round 13)
 * — the same message the documentation refusal prints, plus the declared set
 * as one `Accepts:` line. It printed `Unknown flag "--x" for \`shrk …\`` while
 * every other refusal printed `--x is not a flag of this command`. A
 * `--depth -1` misread names the flag the number was meant for; otherwise the
 * flag is echoed as TYPED (the key alone cannot tell `--x` from `-x`).
 */
function unknownFlag(
  path: readonly string[],
  bad: string,
  declared: ReadonlySet<string>,
  argv?: readonly string[],
): IInvocationRejection {
  const label = path.join(' ');
  const listed = [...declared].filter((f) => !IMPLICIT_FLAGS.has(f));
  return unknownFlagRefusal({
    label,
    flags: [bad],
    known: listed,
    accepts: listed,
    ...(argv !== undefined ? { argv } : {}),
    exitCode: usageExitFor(label),
  });
}
