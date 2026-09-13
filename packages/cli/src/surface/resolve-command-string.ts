import {
  CommandResolutionStatus,
  type ICommandResolution,
  type ICommandResolveOptions,
} from '@shrkcrft/inspector';
import { parseArgs, type ParsedArgs } from '../command-registry.ts';
import { closestMatches, typoTolerance } from '../dispatch/closest-match.ts';
import {
  GLOBAL_VALUE_FLAGS,
  PATH_TRANSPARENCY,
  STRIPPED_GLOBAL_FLAGS,
  withoutPathGlobals,
} from '../dispatch/global-flags.ts';
import { wantsHelp } from '../dispatch/help-intercept.ts';
import { InvocationRejectionKind } from '../dispatch/invocation-rejection-kind.ts';
import { judgeInvocation } from '../dispatch/judge-invocation.ts';
import { PositionalMode } from '../dispatch/positional-mode.ts';
import { isCommandWord, subverbNamesOf } from './command-index.ts';
import type { ICommandIndex } from './i-command-index.ts';
import type { ICommandStringContext } from './i-command-string-context.ts';

/**
 * THE command-string resolver: "does this string an asset prescribes actually
 * run?".
 *
 * Playbooks, pipelines, routing hints, presets, knowledge references and
 * decision records all carry shell commands as free text, and nothing checked
 * them — a renamed verb kept shipping authoritative-looking instructions that
 * fail the moment an agent runs them. Every consumer resolves through this
 * function (the inspector receives it by injection), against the ONE command
 * index — never against the catalog alone, which is missing 75 dispatchable
 * verbs.
 *
 * Tokenising is quote-aware. `&&` / `||` / `;` / `|` segments are each
 * checked (the worst segment decides), and EACH segment drops a leading `$`
 * prompt and `ENV=val` assignments — so `$ shrk doctor && $ shrk frobnicate`
 * is judged on its dead second command. Recognised forms:
 *
 *   - `shrk …`, `npx shrk …`, `bunx shrk …`, `bun run shrk …`, `bun x shrk …`,
 *     `bun packages/cli/src/main.ts …` (and `shrk@<version>` in any of them)
 *     → resolved against the index;
 *   - `bun|npm|pnpm|yarn run <x>` → the root package.json scripts;
 *   - a bare MCP-tool-shaped id (`get_task_packet`) → the registered tools;
 *   - with `options.assumeShrk` (a command REFERENCE — see
 *     `ICommandResolveOptions`): a bare command-word head is read as
 *     `shrk <…>` — `doctor` is ok, `frobnicate` an unknown verb — unless the
 *     head is not a shrk verb but a package manager or a known executable
 *     (`bun test`, `git status`), which stays `NotShrk`. This is the ONE place
 *     the bare form is decided;
 *   - anything else → `NotShrk` (skipped, counted).
 *
 * The verdicts (see {@link CommandResolutionStatus}):
 *   - a verb chain the index proves, followed by nothing, a flag, a
 *     placeholder, a quoted or path-like argument → `Ok`;
 *   - a proven verb whose handler dispatches its tail internally, when the next
 *     bare token is not a known subverb → `PrefixOnly` (it may be a free
 *     positional; the handler would have to declare `positionals: None` to
 *     prove otherwise) — counted, never flagged;
 *   - a command GROUP (no handler) or a handler declaring `positionals: None`,
 *     followed by a bare token that is not one of its subverbs →
 *     `UnknownSubverb`;
 *   - no registered verb → `UnknownVerb`.
 *
 * Before any `Ok` / `PrefixOnly` is returned, the string is put through THE
 * dispatcher's own pre-run judgement (`judgeInvocation` — the function
 * `runCliInner` calls), over the argv the dispatcher would read: a path-mode
 * verb-shaped token that is no subverb and no file (`api-diff status`) →
 * `UnknownSubverb`; a flag outside a declared set or named by none of the
 * command's documentation (`gates check --chnged-only`) → `UnknownFlag`. Only
 * what a documented string can honestly show is judged: positionals stop at
 * the first placeholder (`<file>`, `[a|b]`, `...`) and a flag is read by the
 * name it spells. A string this resolver certifies is one the dispatcher runs.
 */

interface IToken {
  readonly text: string;
  readonly quoted: boolean;
}

const SHRK_PREFIXES: readonly (readonly string[])[] = [
  ['shrk'],
  ['npx', 'shrk'],
  ['bunx', 'shrk'],
  ['bun', 'run', 'shrk'],
  ['bun', 'x', 'shrk'],
  ['pnpm', 'exec', 'shrk'],
  ['pnpm', 'shrk'],
  ['yarn', 'shrk'],
  ['bun', 'packages/cli/src/main.ts'],
  ['bun', './packages/cli/src/main.ts'],
];

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['bun', 'npm', 'pnpm', 'yarn']);
/**
 * Heads a command REFERENCE may legitimately cite that are not shrk verbs —
 * only consulted under `assumeShrk`, and only when shrk does not PROVE the
 * whole string (`ok` / `prefix-only`): shrk has a `git` group, so `git status`
 * is the real git, while a string shrk fully dispatches still reads as shrk. A
 * head not listed here is reported as the unknown shrk verb it was read as:
 * loud, with the closest real command, never silently skipped.
 */
const KNOWN_EXECUTABLES: ReadonlySet<string> = new Set([
  ...PACKAGE_MANAGERS,
  'npx',
  'bunx',
  'node',
  'deno',
  'tsc',
  'tsx',
  'git',
  'gh',
  'make',
  'docker',
  'jq',
  'curl',
  'echo',
  'cat',
  'ls',
  'cd',
  'rm',
  'mkdir',
  'cp',
  'mv',
  'grep',
  'rg',
  'sed',
  'awk',
  'cargo',
  'go',
  'python',
  'python3',
  'pip',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'pytest',
]);
/** `shrk@latest`, `shrk@0.1.0-alpha.31` — a versioned package spec of the shrk binary. */
const VERSIONED_SHRK = /^shrk@\S+$/;
const MCP_TOOL_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * A shell redirection (`> out.json`, `>> log`, `2>&1`, `&> x`, a bare `<`):
 * the command ends before it — the target is the shell's, never an argument.
 * A `<placeholder>` is not one (it closes its own `>`).
 */
const REDIRECTION = /^(?:\d*>>?|&>>?|\d*>&\d*|<)[^<>\s]*$/;
/** A token that could be a subverb name (lowercase kebab, starts with a letter). */
const BARE_SUBVERB = /^[a-z][a-z0-9-]*$/;

/**
 * THE dispatcher's pre-dispatch strip set (dispatch/global-flags.ts) as argv
 * tokens: a value-taking global is removed with its value, a bare one alone.
 * Derived, never copied — a global flag the dispatcher learns reaches the
 * resolver the same day.
 */
const STRIPPED_VALUE_TOKENS: ReadonlySet<string> = new Set(
  [...STRIPPED_GLOBAL_FLAGS].filter((f) => GLOBAL_VALUE_FLAGS.has(f)).map((f) => `--${f}`),
);
const STRIPPED_BARE_TOKENS: ReadonlySet<string> = new Set(
  [...STRIPPED_GLOBAL_FLAGS].filter((f) => !GLOBAL_VALUE_FLAGS.has(f)).map((f) => `--${f}`),
);

/** `--cwd=<dir>` / `--compress-type=<t>` — the `=` form of a stripped value global. */
function isStrippedValueAssignment(text: string): boolean {
  const eq = text.indexOf('=');
  return eq > 2 && STRIPPED_VALUE_TOKENS.has(text.slice(0, eq));
}

/**
 * `argv` in the order the dispatcher reads it: the command path first, the
 * path-transparent globals (`--no-hints`, `--strict`) stepped over exactly as
 * the trie descent steps over them (`withoutPathGlobals`, THE authority) — so
 * `shrk --no-hints scaffolds list` resolves `scaffolds list`, and `doctor
 * --strict warnings` keeps `warnings` as the value of `--strict`. A quoted
 * token never takes part in the descent. The registry-less fallback index has
 * no trie to descend, and keeps argv as written.
 */
function dispatchView(index: ICommandIndex, argv: readonly IToken[]): IToken[] {
  if (!index.registry) return [...argv];
  const quoted = new Map<string, IToken>();
  const texts = argv.map((t, i) => {
    if (!t.quoted) return t.text;
    // An unquoted token never contains whitespace, so this key cannot collide.
    const key = `quoted #${i}`;
    quoted.set(key, t);
    return key;
  });
  return withoutPathGlobals(texts, index.registry).map((text) => quoted.get(text) ?? { text, quoted: false });
}

/** Meta flags `runCliInner` handles before dispatch. */
const META_FLAGS: ReadonlySet<string> = new Set([
  '--help',
  '-h',
  '--full-help',
  '--version',
  '-v',
  '--about',
]);

function rank(status: CommandResolutionStatus): number {
  switch (status) {
    case CommandResolutionStatus.UnknownVerb:
    case CommandResolutionStatus.UnknownSubverb:
    case CommandResolutionStatus.UnknownFlag:
    case CommandResolutionStatus.UnknownScript:
    case CommandResolutionStatus.UnknownTool:
      return 3;
    case CommandResolutionStatus.PrefixOnly:
      return 2;
    case CommandResolutionStatus.Ok:
      return 1;
    default:
      return 0;
  }
}

function stripPrompt(raw: string): string {
  let text = raw.trim();
  if (text.length >= 2 && text.startsWith('`') && text.endsWith('`') && !text.slice(1, -1).includes('`')) {
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('$ ')) text = text.slice(2).trim();
  return text;
}

/** Split on `&&`, `||`, `;`, `|` and newlines that sit outside quotes. */
function splitSegments(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && text[i + 1] === '&')) {
      out.push(current);
      current = '';
      if ((ch === '&' || ch === '|') && text[i + 1] === ch) i += 1;
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function tokenize(segment: string): IToken[] {
  const out: IToken[] = [];
  let current = '';
  let quoted = false;
  let inToken = false;
  let quote: string | null = null;
  const flush = (): void => {
    if (inToken) out.push({ text: current, quoted });
    current = '';
    quoted = false;
    inToken = false;
  };
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      quoted = true;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
    inToken = true;
  }
  flush();
  return out;
}

function matchShrkPrefix(tokens: readonly IToken[]): number {
  let best = -1;
  for (const prefix of SHRK_PREFIXES) {
    if (prefix.length > tokens.length) continue;
    const matches = (p: string, t: IToken): boolean =>
      !t.quoted && (t.text === p || (p === 'shrk' && VERSIONED_SHRK.test(t.text)));
    if (prefix.every((p, i) => matches(p, tokens[i]!))) {
      best = Math.max(best, prefix.length);
    }
  }
  return best;
}

function shrk(path: string): string {
  return path.length > 0 ? `shrk ${path}` : 'shrk';
}

function unknownVerb(index: ICommandIndex, run: readonly string[], raw: string): ICommandResolution {
  const attempt = run.join(' ');
  const suggestions: string[] = [];
  // Full-path candidates first (`search-tuning explain` → `search tuning
  // explain` is one edit), then the top-level verb alone.
  for (let n = Math.min(3, run.length); n >= 1; n -= 1) {
    const head = run.slice(0, n).join(' ');
    for (const hit of closestMatches(head, index.entries.map((e) => e.path), 3, typoTolerance(head))) {
      if (!suggestions.includes(hit)) suggestions.push(hit);
    }
  }
  const tops = new Set<string>();
  for (const e of index.entries) {
    const head = e.tokens[0];
    if (head && !head.startsWith('-')) tops.add(head);
    for (const alias of e.aliases) {
      const aliasHead = alias.split(' ')[0];
      if (aliasHead) tops.add(aliasHead);
    }
  }
  for (const hit of closestMatches(run[0] ?? attempt, tops, 3)) {
    if (!suggestions.includes(hit)) suggestions.push(hit);
  }
  return {
    status: CommandResolutionStatus.UnknownVerb,
    reason: `shrk has no \`${run[0] ?? raw}\` command`,
    ...(suggestions.length > 0 ? { closest: suggestions.slice(0, 3).map(shrk) } : {}),
  };
}

/** A token a usage line or doc writes in place of a real argument (`<file>`, `[a|b]`, `...`, `$VAR`, `*`). */
const PLACEHOLDER = /^(?:<|\[|\.\.\.|…|\$|\*)|\|/;
/** The name a documented flag spells: `--save-conversation[=<path>]` → `save-conversation`. */
const FLAG_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*/;

/**
 * `parsed` as far as a DOCUMENTED string can be judged: the positionals up to
 * the first placeholder — what follows one is not a real argument — and each
 * flag by the name it spells (`--a|--b` → `a`); a flag with no name-shaped
 * prefix is not judged.
 */
function judgeable(parsed: ParsedArgs): ParsedArgs {
  const cut = parsed.positional.findIndex((p) => PLACEHOLDER.test(p));
  const flags = new Map<string, string | boolean>();
  for (const [key, value] of parsed.flags) {
    const name = FLAG_NAME.exec(key)?.[0];
    if (name !== undefined) flags.set(name, value);
  }
  return {
    positional: cut < 0 ? [...parsed.positional] : parsed.positional.slice(0, cut),
    flags,
    multiFlags: parsed.multiFlags,
  };
}

/**
 * Drop the `[ … ]` optional groups a usage line spells (`doctor --watch
 * [--debounce N]`) — documentation of what MAY follow, never an argument.
 */
function dropOptionalGroups(tokens: readonly IToken[]): IToken[] {
  const out: IToken[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (!t.quoted && (depth > 0 || t.text.startsWith('['))) {
      depth += (t.text.match(/\[/g)?.length ?? 0) - (t.text.match(/\]/g)?.length ?? 0);
      if (depth < 0) depth = 0;
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * THE dispatcher's pre-run judgement (`judgeInvocation`) over the argv
 * `runCliInner` would dispatch — the stripped globals removed, the same
 * path-transparent descent, the handler's own boolean flags — mapped onto the
 * resolver's vocabulary. `undefined` when the dispatcher would run it (or when
 * the index has no registry to dispatch from).
 */
function dispatcherRefusal(
  index: ICommandIndex,
  stripped: readonly IToken[],
  ctx: ICommandStringContext,
): ICommandResolution | undefined {
  const registry = index.registry;
  if (!registry) return undefined;
  const res = registry.resolve(
    dropOptionalGroups(stripped).map((t) => t.text),
    PATH_TRANSPARENCY,
  );
  if (res.matchedPath.length === 0) return undefined;
  const parsed = judgeable(
    parseArgs(res.rest, res.handler?.booleanFlags ? { booleanFlags: res.handler.booleanFlags } : {}),
  );
  // `--help` / `-h` anywhere prints help and runs nothing — the dispatcher's intercept.
  if (parsed.flags.has('help') || parsed.flags.has('h')) return undefined;
  const rejection = judgeInvocation({
    registry,
    handler: res.handler,
    matchedPath: res.matchedPath,
    trieChildren: [...res.node.children.keys()],
    parsed,
    index,
    ...(ctx.root !== undefined ? { cwd: ctx.root } : {}),
  });
  if (!rejection) return undefined;
  const reason = (rejection.message.split('\n')[0] ?? '').replace(/^!\s*/, '').trim();
  return {
    status:
      rejection.kind === InvocationRejectionKind.UnknownFlag
        ? CommandResolutionStatus.UnknownFlag
        : CommandResolutionStatus.UnknownSubverb,
    matched: res.matchedPath.join(' '),
    reason,
    ...(rejection.closest && rejection.closest.length > 0 ? { closest: [...rejection.closest] } : {}),
  };
}

function resolveShrk(
  index: ICommandIndex,
  tokens: readonly IToken[],
  raw: string,
  ctx: ICommandStringContext,
): ICommandResolution {
  // The global flags runCliInner strips from anywhere, then the dispatcher's
  // own descent over the path-transparent ones.
  const stripped: IToken[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (!t.quoted && STRIPPED_VALUE_TOKENS.has(t.text)) {
      const next = tokens[i + 1];
      if (next && !next.text.startsWith('-')) i += 1;
      continue;
    }
    if (!t.quoted && isStrippedValueAssignment(t.text)) continue;
    if (!t.quoted && STRIPPED_BARE_TOKENS.has(t.text)) continue;
    stripped.push(t);
  }
  const argv = dispatchView(index, stripped);
  const first = argv[0];
  if (!first) {
    return { status: CommandResolutionStatus.Ok, matched: '', reason: 'bare `shrk` (the landing screen)' };
  }
  if (!first.quoted && META_FLAGS.has(first.text)) {
    return { status: CommandResolutionStatus.Ok, matched: first.text };
  }

  const run: string[] = [];
  for (const t of argv) {
    if (t.quoted || !isCommandWord(t.text)) break;
    run.push(t.text);
  }
  if (run.length === 0) {
    if (first.quoted || first.text.startsWith('<')) {
      // `shrk "<task>"` — documented: free-form text routes to `shrk recommend`.
      return {
        status: CommandResolutionStatus.Ok,
        matched: '',
        reason: 'free-form task text (routes to `shrk recommend`)',
      };
    }
    return {
      status: CommandResolutionStatus.UnknownVerb,
      reason: `\`${first.text}\` before the verb is not a global flag — shrk would not dispatch this`,
    };
  }

  // Alias-aware trie descent (the real dispatch authority), or — for the
  // registry-less fallback index — the longest indexed prefix.
  let matched: string[];
  let pureGroup = false;
  if (index.registry) {
    const res = index.registry.resolve(run);
    matched = [...res.matchedPath];
    if (matched.length === 0) return unknownVerb(index, run, raw);
    pureGroup = !res.handler && res.node.children.size > 0;
  } else {
    matched = [];
    for (let n = run.length; n >= 1; n -= 1) {
      if (index.byPath.has(run.slice(0, n).join(' '))) {
        matched = run.slice(0, n);
        break;
      }
    }
    if (matched.length === 0) return unknownVerb(index, run, raw);
  }

  // Extend through subverbs the index knows (catalog-documented or declared) —
  // the LONGEST indexed path, even when an intermediate level has no row of its
  // own (`ci scaffold gitlab` is documented; `ci scaffold` is not).
  const canonical = [...matched, ...run.slice(matched.length)];
  let depth = matched.length;
  let path = matched.join(' ');
  for (let k = canonical.length; k > matched.length; k -= 1) {
    const deeper = canonical.slice(0, k).join(' ');
    // A declared subverb's alias (`commands workflows` → `commands
    // entrypoints`) dispatches exactly like its name — the declared walk
    // matches aliases, so the resolver reads them too.
    const entry = index.byPath.get(deeper) ?? index.entries.find((e) => e.aliases.includes(deeper));
    if (entry) {
      depth = k;
      path = entry.path;
      pureGroup = false;
      break;
    }
  }

  // `--help` / `-h` anywhere after a proven verb prints help and runs nothing —
  // the dispatcher's help intercept answers before any guard, whatever the
  // rest of the line says (`check rules --help` is help for `check`).
  if (wantsHelp(argv.slice(matched.length).map((t) => t.text))) {
    return { status: CommandResolutionStatus.Ok, matched: path, reason: '`--help` prints help and runs nothing' };
  }

  // A chain the index proves is still put through the dispatcher's own
  // judgement before it is certified: the one answer to "does this run?".
  const settle = (proven: ICommandResolution): ICommandResolution =>
    dispatcherRefusal(index, stripped, ctx) ?? proven;

  const next = argv[depth];
  if (!next || next.quoted || !BARE_SUBVERB.test(next.text)) {
    return settle({ status: CommandResolutionStatus.Ok, matched: path });
  }

  const children = subverbNamesOf(index, path);
  const closest = closestMatches(next.text, children, 3).map((c) => shrk(`${path} ${c}`));
  const withClosest = closest.length > 0 ? { closest } : {};
  if (pureGroup) {
    return {
      status: CommandResolutionStatus.UnknownSubverb,
      matched: path,
      reason: `\`shrk ${path}\` is a command group; \`${next.text}\` is not one of its subcommands`,
      ...withClosest,
    };
  }
  const mode = index.byPath.get(path)?.positionals;
  if (mode === PositionalMode.None) {
    return {
      status: CommandResolutionStatus.UnknownSubverb,
      matched: path,
      reason: `\`shrk ${path}\` has no \`${next.text}\` subcommand`,
      ...withClosest,
    };
  }
  if (mode === PositionalMode.Free || mode === PositionalMode.Path) {
    // A path-mode verb-shaped token that is no subverb and no file is refused
    // by the dispatcher (`api-diff status`) — `settle` finds that out.
    return settle({ status: CommandResolutionStatus.Ok, matched: path });
  }
  if (children.length > 0) {
    return settle({
      status: CommandResolutionStatus.PrefixOnly,
      matched: path,
      reason: `\`shrk ${path}\` dispatches \`${next.text}\` internally — not provable from the command index`,
      ...withClosest,
    });
  }
  // A leaf with no known subverbs: the token is its positional argument.
  return settle({ status: CommandResolutionStatus.Ok, matched: path });
}

function resolveScript(pm: string, name: string, ctx: ICommandStringContext): ICommandResolution {
  if (!ctx.scripts) {
    return { status: CommandResolutionStatus.NotShrk, reason: 'no root package.json scripts to check against' };
  }
  if (ctx.scripts.has(name)) return { status: CommandResolutionStatus.Ok, reason: `package script \`${name}\`` };
  const closest = closestMatches(name, ctx.scripts, 3).map((s) => `${pm} run ${s}`);
  return {
    status: CommandResolutionStatus.UnknownScript,
    reason: `the root package.json has no \`${name}\` script`,
    ...(closest.length > 0 ? { closest } : {}),
  };
}

function resolveTool(name: string, ctx: ICommandStringContext): ICommandResolution {
  if (!ctx.mcpToolNames) {
    return { status: CommandResolutionStatus.NotShrk, reason: 'no MCP tool list to check against' };
  }
  if (ctx.mcpToolNames.has(name)) return { status: CommandResolutionStatus.Ok, reason: `MCP tool \`${name}\`` };
  const closest = closestMatches(name, ctx.mcpToolNames, 3);
  return {
    status: CommandResolutionStatus.UnknownTool,
    reason: `no MCP tool is named \`${name}\``,
    ...(closest.length > 0 ? { closest } : {}),
  };
}

function resolveSegment(
  index: ICommandIndex,
  segment: string,
  ctx: ICommandStringContext,
  options: ICommandResolveOptions,
): ICommandResolution {
  const tokens = tokenize(segment);
  // A shell prompt on ANY segment (`… && $ shrk x`), not only the first: a
  // `$` left in place made the segment not-shrk, which outranked nothing and
  // let a dead verb behind it pass.
  if (tokens.length > 0 && !tokens[0]!.quoted && tokens[0]!.text === '$') tokens.shift();
  while (tokens.length > 0 && !tokens[0]!.quoted && ENV_ASSIGNMENT.test(tokens[0]!.text)) {
    tokens.shift();
  }
  // `shrk quality --ci > quality.json` runs `shrk quality --ci`.
  const redirect = tokens.findIndex((t) => !t.quoted && REDIRECTION.test(t.text));
  if (redirect >= 0) tokens.splice(redirect);
  if (tokens.length === 0) return { status: CommandResolutionStatus.NotShrk };
  const prefix = matchShrkPrefix(tokens);
  if (prefix >= 0) return resolveShrk(index, tokens.slice(prefix), segment, ctx);
  const [a, b, c] = tokens;
  if (a && b && c && !a.quoted && PACKAGE_MANAGERS.has(a.text) && b.text === 'run' && !c.quoted) {
    return resolveScript(a.text, c.text, ctx);
  }
  if (tokens.length === 1 && a && !a.quoted && MCP_TOOL_ID.test(a.text)) {
    return resolveTool(a.text, ctx);
  }
  if (options.assumeShrk === true && a && !a.quoted && isCommandWord(a.text)) {
    // A command REFERENCE: the bare form names a shrk verb (`doctor` →
    // `shrk doctor`). A known-executable head (`git status`, `bun test`) is
    // not ours to judge unless shrk PROVES the whole string — shrk has a `git`
    // group, and `git status` must not read as its unknown subverb.
    const asShrk = resolveShrk(index, tokens, segment, ctx);
    const proven =
      asShrk.status === CommandResolutionStatus.Ok || asShrk.status === CommandResolutionStatus.PrefixOnly;
    if (!proven && KNOWN_EXECUTABLES.has(a.text)) {
      return { status: CommandResolutionStatus.NotShrk, reason: `\`${a.text}\` is read as a shell command, not shrk` };
    }
    if (asShrk.status === CommandResolutionStatus.UnknownVerb) {
      return {
        ...asShrk,
        reason: `${asShrk.reason ?? `shrk has no \`${a.text}\` command`} (a bare command reference is read as \`shrk ${a.text}\`)`,
      };
    }
    return asShrk;
  }
  return { status: CommandResolutionStatus.NotShrk };
}

/**
 * Resolve one command string against the command index. Deterministic and
 * pure. `options.assumeShrk` asks for the command-REFERENCE reading of a bare
 * form (see the module comment).
 */
export function resolveCommandString(
  index: ICommandIndex,
  raw: string,
  ctx: ICommandStringContext = {},
  options: ICommandResolveOptions = {},
): ICommandResolution {
  const segments = splitSegments(stripPrompt(raw));
  if (segments.length === 0) {
    return { status: CommandResolutionStatus.NotShrk, reason: 'empty command string' };
  }
  let worst: ICommandResolution | undefined;
  for (const segment of segments) {
    const r = resolveSegment(index, segment, ctx, options);
    const tagged = segments.length > 1 ? { ...r, segment } : r;
    if (!worst || rank(r.status) > rank(worst.status)) worst = tagged;
  }
  return worst!;
}
