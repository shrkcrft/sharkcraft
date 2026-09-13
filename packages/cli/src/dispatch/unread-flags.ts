import type { ICommandHandler, ParsedArgs } from '../command-registry.ts';
import { ExitCode, isGateVerb, usageExitFor } from '../exit-codes.ts';
import type { ICommandIndex } from '../surface/i-command-index.ts';
import { GLOBAL_FLAGS, SOFT_FLAGS } from './global-flags.ts';
import type { IDeclaredInvocation } from './i-declared-invocation.ts';
import type { IInvocationRejection } from './invocation-rejection.ts';
import { ReadTrackingMap } from './read-tracking-map.ts';
import type { ISubverbSpec } from './subverb-spec.ts';
import { UNDOCUMENTED_FLAG_READS } from './undocumented-flag-reads.ts';
import { unknownFlagRefusal } from './unknown-flag-refusal.ts';
import { UnknownFlagRefusalMode } from './unknown-flag-refusal-mode.ts';
import { walkDeclaredSubverbs } from './walk-declared-subverbs.ts';

/**
 * THE post-run unknown-flag detector (round 11 §5.2) — universal, zero
 * annotation. `shrk check --tag auth` printed a green sweep at exit 0: `check`
 * has no `--tag`, the parser accepted it as a flag, nothing read it. Now:
 *
 *   - a supplied flag the handler never READ and its usage never DOCUMENTS was
 *     dropped → stderr names it (with the closest documented flag), and a `0`
 *     becomes `usageExitFor(path)`: a clean verdict over a dropped input is the
 *     lie. A non-zero exit is kept.
 *   - a documented-but-unread flag (`doctor --provider` without
 *     `--llm-recommendations`) NEVER changes the exit — reading a flag only in
 *     some modes is legitimate.
 *   - presentation flags (`SOFT_FLAGS`) are warned about, never escalated.
 *
 * Skipped when the handler declares `flags` (the pre-run guard is then
 * authoritative) or `forwardsArgv` (a child process re-parses the argv, so
 * this process's reads prove nothing).
 */
export function tracksFlagReads(handler: ICommandHandler, walk: IDeclaredInvocation): boolean {
  return handler.forwardsArgv !== true && walk.flags === undefined;
}

/**
 * Swap `parsed.flags` / `parsed.multiFlags` for read-tracking copies (in place)
 * and return a probe: the supplied flags nothing read, global flags and the
 * bare `-` (stdin) sentinel excluded. Call the probe after the handler returns.
 */
export function beginFlagReadTracking(parsed: ParsedArgs): () => string[] {
  const supplied = [...parsed.flags.keys()];
  const flags = ReadTrackingMap.from(parsed.flags);
  const multi = ReadTrackingMap.from(parsed.multiFlags);
  parsed.flags = flags;
  parsed.multiFlags = multi;
  return () =>
    supplied.filter(
      (key) => key.length > 0 && !GLOBAL_FLAGS.has(key) && !flags.wasRead(key) && !multi.wasRead(key),
    );
}

/**
 * Every text that documents the flags of the handler at `matchedPath` AS ITS
 * USAGE records them: its usage, every declared subverb's usage (nested), and
 * — from the command index — the usage, catalog row and folded flag variants of
 * every entry at or below the path. Wider documentation only ever makes the
 * detector quieter.
 *
 * This is the HANDLER-WIDE union — what `r75-flag-read-ledger` holds the
 * ledger against ("is this flag named anywhere for this handler?"). It is
 * NOT what an invocation is judged by: since round 13 a flag is a flag of the
 * subverb that documents it, never of its siblings
 * ({@link invocationFlagDocumentation}).
 */
export function usageFlagDocumentation(
  handler: ICommandHandler,
  matchedPath: readonly string[],
  index: ICommandIndex,
): string[] {
  const docs: string[] = declaredUsages(handler);
  const prefix = matchedPath.join(' ');
  for (const e of index.entries) {
    if (e.path !== prefix && !e.path.startsWith(`${prefix} `)) continue;
    if (e.usage) docs.push(e.usage);
    if (e.catalogEntry) docs.push(e.catalogEntry.command);
    docs.push(...e.variants);
  }
  return docs;
}

/** The handler's own usage and every declared subverb's (nested) — no index needed. */
function declaredUsages(handler: ICommandHandler): string[] {
  const docs: string[] = [handler.usage];
  const addSpecs = (specs: readonly ISubverbSpec[] | undefined): void => {
    for (const spec of specs ?? []) {
      docs.push(spec.usage);
      addSpecs(spec.subverbs);
    }
  };
  addSpecs(handler.subverbs);
  return docs;
}

/** `--key`, or `-k` for a one-letter key — how a parsed flag is spelled on the command line. */
function spellFlag(key: string): string {
  return `${key.length === 1 ? '-' : '--'}${key}`;
}

/**
 * The usages along an invocation's declared-subverb walk: the handler's own,
 * then each walked subverb's (`check` → `check templates`). A SIBLING's usage
 * never appears — `check boundaries` documenting `--fail-on-dead-units` makes
 * it a flag of `check boundaries`, not of `check` or `check templates`.
 */
function walkedUsages(handler: ICommandHandler, walk: IDeclaredInvocation, matchedPath: readonly string[]): string[] {
  const docs: string[] = [handler.usage];
  let specs = handler.subverbs;
  for (const name of walk.path.slice(matchedPath.length)) {
    const spec: ISubverbSpec | undefined = (specs ?? []).find((s) => s.name === name);
    if (!spec) break;
    docs.push(spec.usage);
    specs = spec.subverbs;
  }
  return docs;
}

/**
 * THE documentation an INVOCATION's flags are judged by (round 13): the usages
 * along its declared-subverb walk ({@link walkedUsages}); from the command
 * index, the usage, catalog row and folded variants of every entry at or below
 * the handler whose path is a token prefix of the invocation (`check`, `check
 * templates` for `shrk check templates …` — never `check boundaries`); and the
 * handler's row of flags its code reads ({@link UNDOCUMENTED_FLAG_READS}).
 *
 * Before round 13 the post-run judgement read {@link flagDocumentation} — the
 * whole group's — so `check --fail-on-dead-units` ran the full sweep at exit 0
 * (only `check boundaries` documents the flag), and `self-config doctor
 * --allow-empty` was accepted and ignored because `self-config broken-links`
 * documents it. Documentation is per subverb, not per group
 * ({@link settleUnreadFlags}).
 */
export function invocationFlagDocumentation(input: {
  readonly handler: ICommandHandler;
  readonly matchedPath: readonly string[];
  /** The positionals as the dispatcher parsed them — BEFORE the run (a handler may consume them). */
  readonly positional: readonly string[];
  readonly index: ICommandIndex;
}): string[] {
  const walk = walkDeclaredSubverbs(input.handler, input.matchedPath, input.positional);
  const docs = walkedUsages(input.handler, walk, input.matchedPath);
  const tokens = [...walk.path, ...input.positional.slice(walk.consumed)];
  for (const e of input.index.entries) {
    if (e.tokens.length < input.matchedPath.length || e.tokens.length > tokens.length) continue;
    if (e.tokens.some((t, i) => t !== tokens[i])) continue;
    if (e.usage) docs.push(e.usage);
    if (e.catalogEntry) docs.push(e.catalogEntry.command);
    docs.push(...e.variants);
  }
  const read = UNDOCUMENTED_FLAG_READS.get(input.matchedPath.join(' '));
  if (read !== undefined && read.length > 0) docs.push(read.map(spellFlag).join(' '));
  return docs;
}

/**
 * What the post-run detector treats as the flags of the handler at
 * `matchedPath`: its {@link usageFlagDocumentation}, plus the flags its code
 * READS that the usage does not show yet ({@link UNDOCUMENTED_FLAG_READS}, a
 * ledger locked two-way against the code by `r75-flag-read-ledger`). With
 * both, a flag the detector calls "not a flag of this command" is one no code
 * path of the handler reads (a flag name computed at runtime excepted), so a
 * `0` over it is a dropped input — never a real flag read behind a branch
 * (`export claude-md --write --force` on a fresh file wrote it, then exited 2).
 */
export function flagDocumentation(
  handler: ICommandHandler,
  matchedPath: readonly string[],
  index: ICommandIndex,
): string[] {
  const docs = usageFlagDocumentation(handler, matchedPath, index);
  const read = UNDOCUMENTED_FLAG_READS.get(matchedPath.join(' '));
  if (read !== undefined && read.length > 0) docs.push(read.map(spellFlag).join(' '));
  return docs;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `--key` (or `-k` for a one-letter key) appears as a flag in any of `docs`. */
export function isFlagDocumented(key: string, docs: readonly string[]): boolean {
  const dashes = key.length === 1 ? '-' : '--';
  const re = new RegExp(`(^|[^A-Za-z0-9-])${dashes}${escapeRegExp(key)}(?![A-Za-z0-9-])`);
  return docs.some((d) => re.test(d));
}

/** Every `--flag` named in `docs` — the candidates a refusal's did-you-mean picks from. */
export function documentedFlagNames(docs: readonly string[]): string[] {
  const names = new Set<string>();
  for (const d of docs) {
    for (const m of d.matchAll(/(?:^|[^A-Za-z0-9-])--([a-z0-9][a-z0-9-]*)/gi)) {
      if (m[1]) names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * THE pre-run half of the undocumented-flag rule (round 11 review): a supplied
 * flag that is not a flag of the command GROUP — named by none of its
 * {@link flagDocumentation} (its usage and every declared subverb's, the
 * command index at or below the path, and the two-way-locked ledger of flags
 * its code reads) — is refused BEFORE the body runs. Whether a flag is
 * undocumented is static, so nothing justifies running first: `baseline
 * update --dry-rn` performed the bless write, then exited 3; `check --tag
 * auth` printed a whole sweep first.
 *
 * A flag the group documents only on a SIBLING subverb is judged after the run
 * instead ({@link settleUnreadFlags} with the invocation's own
 * {@link invocationFlagDocumentation}, round 13): whether THIS subverb's code
 * reads it is not static knowledge — a group's shared option is often
 * documented on one subverb and read by all of them — so refusing it here
 * would refuse real inputs. The message is THE one refusal format
 * ({@link unknownFlagRefusal}).
 *
 * Presentation flags (`SOFT_FLAGS`) are left to the post-run warning — losing
 * `--verbose` loses formatting, not an input. The index is built only when the
 * handler's own usages leave a flag unexplained, so the common run pays
 * nothing.
 */
export function refuseUndocumentedFlags(input: {
  readonly handler: ICommandHandler;
  readonly matchedPath: readonly string[];
  /** The declared walk's path — what the message and `usageExitFor` name. */
  readonly label: string;
  readonly parsed: ParsedArgs;
  readonly index: () => ICommandIndex;
}): IInvocationRejection | undefined {
  const supplied = [...input.parsed.flags.keys()].filter(
    (key) => key.length > 0 && !GLOBAL_FLAGS.has(key) && !SOFT_FLAGS.has(key),
  );
  if (supplied.length === 0) return undefined;
  const own = declaredUsages(input.handler);
  const unsure = supplied.filter((key) => !isFlagDocumented(key, own));
  if (unsure.length === 0) return undefined;
  const docs = flagDocumentation(input.handler, input.matchedPath, input.index());
  const undocumented = unsure.filter((key) => !isFlagDocumented(key, docs));
  if (undocumented.length === 0) return undefined;
  return unknownFlagRefusal({
    label: input.label,
    flags: undocumented,
    known: documentedFlagNames(docs),
    argv: input.parsed.argv,
    exitCode: usageExitFor(input.label),
  });
}

/**
 * The command paths at or below `matchedPath` (other than the invocation's
 * own chain) whose documentation names `key` — the sibling subverbs the
 * refusal points at (`— only \`shrk check boundaries\` documents it`).
 */
export function siblingsDocumenting(
  key: string,
  matchedPath: readonly string[],
  invocationPath: readonly string[],
  index: ICommandIndex,
): string[] {
  const prefix = matchedPath.join(' ');
  const own = new Set(invocationPath.map((_, i) => invocationPath.slice(0, i + 1).join(' ')));
  const out: string[] = [];
  for (const e of index.entries) {
    if (e.path !== prefix && !e.path.startsWith(`${prefix} `)) continue;
    if (own.has(e.path)) continue;
    const docs = [e.usage ?? '', e.catalogEntry?.command ?? '', ...e.variants];
    if (isFlagDocumented(key, docs)) out.push(e.path);
  }
  return out.slice(0, 3);
}

/**
 * Judge the unread flags of a finished run against the INVOCATION's
 * documentation (`documentation`: {@link invocationFlagDocumentation} — the
 * subverb's own, never a sibling's):
 *
 *   - a flag named by no documentation of the group: warned, and a `0`
 *     becomes `usageExitFor(path)` (the backstop for a name computed at
 *     runtime — the pre-run judgement refuses the rest);
 *   - round 13 — a flag only a SIBLING subverb documents (`groupDocumentation`
 *     names it, the invocation's does not) that this run never read is REFUSED
 *     like any dropped flag: a `0` becomes `usageExitFor(path)` on every verb,
 *     and on a verdict verb a `2` does too (a found failure `1` is kept).
 *     `check --fail-on-dead-units` ran the sweep at exit 0 (only `check
 *     boundaries` documents the flag); `self-config doctor --allow-empty`
 *     ignored it; `registrations list --fail-on-dead-units` kept its 0 with a
 *     warning (round 13 review — documentation is per subverb on every verb). A
 *     sibling-documented flag the run READ is a real input and never judged.
 *
 * Presentation flags (`SOFT_FLAGS`) are only ever warned about. Returns `exit`
 * unchanged when nothing is judged.
 */
export function settleUnreadFlags(input: {
  readonly unread: readonly string[];
  readonly path: string;
  readonly documentation: readonly string[];
  /** The whole group's documentation ({@link flagDocumentation}) — what tells a sibling-only flag apart. */
  readonly groupDocumentation?: readonly string[];
  /** Per flag key, the sibling command paths that document it — named in the message. */
  readonly documentedOn?: (key: string) => readonly string[];
  readonly exit: number;
  readonly write?: (text: string) => void;
  /** The argv the handler's args were parsed from — to name each flag as TYPED. */
  readonly argv?: readonly string[];
}): number {
  const write = input.write ?? ((text: string): void => void process.stderr.write(text));
  const undocumented = input.unread.filter((key) => !isFlagDocumented(key, input.documentation));
  if (undocumented.length === 0) return input.exit;
  const group = input.groupDocumentation;
  const siblingOnly = new Set(group ? undocumented.filter((key) => isFlagDocumented(key, group)) : []);
  const dropped = undocumented.filter((key) => !SOFT_FLAGS.has(key));
  const droppedNowhere = dropped.filter((key) => !siblingOnly.has(key));
  const droppedSibling = dropped.filter((key) => siblingOnly.has(key));
  const code = usageExitFor(input.path);
  // A flag the invocation's documentation does not name is a dropped input
  // whether NO subverb documents it or only a SIBLING does — both are "not a
  // flag of this command": a `0` over it is refused on every verb. On a
  // verdict verb a sibling-only flag refuses a `2` too (a NOT VERIFIED that
  // silently dropped `--allow-empty` reads as the verb's own answer).
  const refuse =
    input.exit !== code &&
    ((input.exit === ExitCode.VerifiedPass && dropped.length > 0) ||
      (droppedSibling.length > 0 && isGateVerb(input.path) && input.exit !== ExitCode.Failure));
  const final = refuse ? code : input.exit;
  const documentedOn: Record<string, readonly string[]> = {};
  for (const key of siblingOnly) {
    const owners = input.documentedOn?.(key) ?? [];
    if (owners.length > 0) documentedOn[key] = owners;
  }
  write(
    unknownFlagRefusal({
      label: input.path,
      flags: undocumented,
      known: documentedFlagNames(input.documentation),
      documentedOn,
      ...(input.argv !== undefined ? { argv: input.argv } : {}),
      exitCode: final,
      mode: refuse ? UnknownFlagRefusalMode.RefusedAfterRun : UnknownFlagRefusalMode.WarnedAfterRun,
    }).message,
  );
  return final;
}
