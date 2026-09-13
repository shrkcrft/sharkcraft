import { detectSharkcraftRepo } from '@shrkcrft/inspector';
import { resolveCwd, type CommandRegistry } from '../command-registry.ts';
import { header } from '../output/format-output.ts';
import { nearest } from '../dispatch/closest-match.ts';
import { CommandDispatchKind } from '../surface/command-dispatch-kind.ts';
import {
  commandIndexFor,
  findCommandIndexEntry,
  subverbNamesOf,
} from '../surface/command-index.ts';
import type { ICommandIndex } from '../surface/i-command-index.ts';
import { loadSurfaceContext } from '../surface/load-surface-context.ts';
import {
  buildSurfaceSummary,
  findCommandInSummary,
  type ISurfaceCommandView,
  type ISurfaceSummary,
} from '../surface/surface-summary.ts';
import { TierSource, type ITierResolverContext } from '../surface/tier.ts';
import { defaultShowInHelp, isExplainFamily } from './command-catalog.ts';

/** `help`'s arguments: a ParsedArgs subset (callers may pass positional + flags only). */
interface IHelpArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
  globalCwd?: string;
}

/**
 * Help's topics come from THE command index — the same inventory `surface
 * list`, `commands doctor`, the command-string resolver and the dispatcher's
 * help intercept read (one memoised object per registry). It used to walk
 * COMMAND_CATALOG itself (a third inventory), so a registered verb with no
 * catalog row had no help and a catalog row nothing dispatches still did.
 */
function helpIndex(registry: CommandRegistry): ICommandIndex {
  return commandIndexFor(registry);
}

/** Every command path (and alias spelling) the index knows — help topics. */
function indexHelpPaths(index: ICommandIndex): Set<string> {
  const paths = new Set<string>();
  for (const e of index.entries) {
    if (e.dispatch === CommandDispatchKind.Meta) continue;
    paths.add(e.path);
    for (const a of e.aliases) paths.add(a);
  }
  return paths;
}

/**
 * Render help for an index path the trie could not resolve verbatim — a
 * subverb its parent dispatches from a positional (`check wiring`) — plus its
 * sibling verbs under the same parent so the family is discoverable from any
 * one member.
 */
function renderIndexHelp(index: ICommandIndex, tokens: readonly string[]): string | undefined {
  const want = tokens.join(' ');
  const entry = findCommandIndexEntry(index, want);
  if (!entry || entry.dispatch === CommandDispatchKind.Meta) return undefined;
  let out = `${entry.path} — ${entry.description}\n`;
  // A catalog-documented subverb its handler does not declare has no usage of
  // its own: fall back to the dispatching handler's, so help always shows how
  // to invoke it (and never an empty page).
  const usage = entry.usage ?? (entry.parent ? index.byPath.get(entry.parent)?.usage : undefined);
  if (usage) out += `${usage}\n`;
  const extra = EXTRA_HELP_LINES[entry.path];
  if (extra) out += extra.join('\n') + '\n';
  const parent = entry.tokens.slice(0, -1).join(' ');
  if (parent.length > 0) {
    const siblings = subverbNamesOf(index, parent)
      .map((name) => `${parent} ${name}`)
      .filter((p) => p !== entry.path)
      .sort();
    if (siblings.length > 0) {
      out += `\nSiblings: ${siblings.join(', ')}\n`;
    }
  }
  return out;
}

/** First sentence of a catalog description, for the compact explain-family list. */
function firstSentence(description: string): string {
  const dot = description.indexOf('. ');
  const head = dot > 0 ? description.slice(0, dot + 1) : description;
  return head.length > 100 ? head.slice(0, 97).trimEnd() + '…' : head;
}

/**
 * The set of real, callable top-level help topics: the first token of every
 * index path, plus every top-level alias. Used only to suggest a near-typo
 * when an unknown topic is requested — never to fabricate one that isn't real.
 * The suggestion goes through the ONE did-you-mean scorer (`nearest`, the
 * `max(1, len/4)`-edit tolerance main.ts uses), ties broken lexically.
 */
function realHelpTopics(index: ICommandIndex): Set<string> {
  const topics = new Set<string>();
  for (const e of index.entries) {
    if (e.dispatch === CommandDispatchKind.Meta) continue;
    const head = e.tokens[0];
    if (head) topics.add(head);
    for (const a of e.aliases) {
      const aliasHead = a.split(' ')[0];
      if (aliasHead) topics.add(aliasHead);
    }
  }
  return topics;
}

const EXTRA_HELP_LINES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  graph: [
    '',
    'Code-intelligence subverbs:',
    '  graph index      — build or refresh the code graph',
    '  graph status     — freshness, counts, and unresolved-import summary',
    '  graph search     — find files/symbols/packages in the code graph',
    '  graph context    — inspect one file or symbol with bridge enrichment',
    '  graph impact     — reverse dependent closure for a file or symbol',
    '  graph callers    — files that call/reference a symbol',
    '  graph importers  — every module that imports a module (alias/type-only/re-export aware)',
    '  graph cycles     — list import cycles',
    '  graph unresolved — list unresolved imports grouped by file',
    '  graph deps       — inbound/outbound package dependencies',
    '  graph why        — shortest-path explanation in the knowledge graph',
  ],
});

/** One curated start-screen line and the command path its visibility follows. */
interface IStartLine {
  readonly command: string;
  readonly text: string;
}

const START_SECTIONS: readonly { readonly title: string; readonly lines: readonly IStartLine[] }[] = [
  {
    title: 'Bootstrap:',
    lines: [
      { command: 'init', text: '  $ shrk init --infer --write      — scan the repo + populate sharkcraft/ from real signals (new repos)' },
      { command: 'doctor', text: '  $ shrk doctor                    — is the workspace healthy?' },
      { command: 'onboard', text: '  $ shrk onboard                   — analyze an existing repo (advisory)' },
    ],
  },
  {
    title: 'Use it for a task:',
    lines: [
      { command: 'recommend', text: '  $ shrk recommend "<task>"        — what should I do?' },
      { command: 'context', text: '  $ shrk context --task "<task>"   — token-budgeted relevant context' },
      { command: 'task', text: '  $ shrk task "<task>"             — full AI-ready task packet (JSON)' },
      { command: 'why', text: '  $ shrk why <file>                — which rules govern this file' },
      { command: 'impact', text: '  $ shrk impact <file>             — blast radius: what breaks if I change this' },
    ],
  },
  {
    title: 'Generate code safely:',
    lines: [
      { command: 'gen', text: '  $ shrk gen <template> <name>     — generate from template (dry-run by default)' },
      { command: 'apply', text: '  $ shrk apply <plan.json>         — apply a reviewed plan (CLI is the only write path)' },
      { command: 'check boundaries', text: '  $ shrk check boundaries          — enforce layer / import boundaries' },
      { command: 'quality', text: '  $ shrk quality                   — pre-PR gate (doctor + boundaries + coverage + drift)' },
    ],
  },
  {
    title: 'Browse what shrk knows:',
    lines: [
      { command: 'graph status', text: '  $ shrk graph status              — code-graph freshness and health' },
      { command: 'coverage', text: '  $ shrk coverage                  — what knowledge is missing' },
      { command: 'knowledge list', text: '  $ shrk knowledge list            — knowledge entries' },
    ],
  },
  {
    title: 'Run shrk for an agent:',
    lines: [
      { command: 'mcp serve', text: '  $ shrk mcp serve                 — start the MCP server (stdio) for live queries' },
      { command: 'dashboard', text: '  $ shrk dashboard                 — start the local read-only dashboard' },
    ],
  },
];

/**
 * Product start screen for bare `shrk` / `shrk --help`. Shows the
 * curated ~20-command "starter" surface organized by workflow phase.
 * Everything else stays callable; users see the full ~70-verb catalog
 * via `shrk --full-help` or browse it through `shrk surface list`.
 *
 * `shown(command)` is the repository's surface: a curated line whose command
 * `surface.hidden` hides, or the surface gate refuses (`surface.disabled`,
 * experimental, tool-maintenance), is dropped — and a section left empty with
 * it. The default shows every line (the text is then byte-identical to the
 * pre-round-11 screen).
 *
 * Returns the lines (without trailing newline). Pulled into a function
 * so tests can assert on the structure without grepping stdout.
 */
export function renderStartScreen(shown: (command: string) => boolean = () => true): string {
  const lines: string[] = [];
  lines.push('SharkCraft CLI — deterministic, local-first project intelligence for AI coding agents.');
  lines.push('Usage: shrk [--cwd <dir>] <command> [...args]');
  lines.push('');
  let dropped = 0;
  for (const section of START_SECTIONS) {
    const kept = section.lines.filter((l) => shown(l.command));
    dropped += section.lines.length - kept.length;
    if (kept.length === 0) continue;
    lines.push(section.title);
    for (const l of kept) lines.push(l.text);
    lines.push('');
  }
  lines.push(
    dropped === 0
      ? 'Discover the rest (everything stays callable — this screen shows ~17 of ~70 verbs):'
      : `Discover the rest (${dropped} curated command(s) are hidden or disabled by this repository's surface config):`,
  );
  lines.push('  $ shrk surface list              — full catalog by tier');
  lines.push('  $ shrk help <command>            — usage for a specific command');
  lines.push('  $ shrk --full-help               — long, exhaustive help (incl. the explain/dry-run family)');
  lines.push('  $ shrk --about                   — what shrk is and is not');
  lines.push('');
  lines.push('Free-form input is fine — `shrk "<task>"` routes to `shrk recommend`.');
  return lines.join('\n') + '\n';
}

/**
 * The surface this repository presents — THE visibility authority: the
 * surface summary over this registry's index, composed with the project's
 * `surface{}` config, its profile and the host (tool repo or consumer). The
 * start screen and `--full-help` render it, so `surface explain X` →
 * `visible-in-help` and the help output can no longer disagree.
 *
 * Failure-soft: when the workspace cannot be loaded, the DEFAULT surface (no
 * config; the host still detected) is rendered and one note says so.
 */
async function helpSurface(
  registry: CommandRegistry,
  cwd: string,
): Promise<{ summary: ISurfaceSummary; note?: string }> {
  const index = helpIndex(registry);
  try {
    const { context } = await loadSurfaceContext({ cwd });
    return { summary: buildSurfaceSummary(context, index) };
  } catch (e) {
    const context: ITierResolverContext = {
      spineCommands: new Set(),
      packContributions: new Map(),
      surfaceConfig: undefined,
      isToolRepo: detectSharkcraftRepo(cwd),
    };
    return {
      summary: buildSurfaceSummary(context, index),
      note: `note: surface config not loaded (${e instanceof Error ? e.message : String(e)}) — showing the default surface.\n`,
    };
  }
}

/** A curated start-screen line stays unless this repository hides or gates its command. */
function startScreenFilter(summary: ISurfaceSummary): (command: string) => boolean {
  return (command) => {
    const view = findCommandInSummary(summary, command);
    return view === undefined || (view.callable && !view.hidden);
  };
}

/** `(hidden)` / `(gated: …)` for `--full-help --all`. */
function helpAnnotation(v: ISurfaceCommandView): string {
  const notes: string[] = [];
  if (!v.visibleInHelp) notes.push('hidden');
  if (!v.callable) {
    notes.push(
      v.source === TierSource.ToolMaintenance
        ? 'gated: tool-maintenance'
        : v.source === TierSource.Disabled
          ? 'gated: disabled'
          : 'gated',
    );
  }
  return notes.length > 0 ? `  (${notes.join(', ')})` : '';
}

/**
 * `--full-help`, rendered FROM the surface summary. Without `all` it lists
 * exactly the views whose `visibleInHelp` is true — every one at least once —
 * so `surface.hidden`, profiles, `surface.disabled` and the tool-maintenance
 * host gate all reach it. With `all` it lists every view, annotated
 * `(hidden)` / `(gated: …)` rather than dropped.
 *
 * Placement (not visibility) still reads the catalog: a visible view on the
 * rent-paying surface goes under its top-level verb or group; an explain /
 * dry-run view goes in its own section (and, when it is also rent-paying, in
 * its group too).
 */
export function renderFullHelp(registry: CommandRegistry, summary: ISurfaceSummary, all: boolean): string {
  const index = helpIndex(registry);
  const views = [...summary.tiers.core, ...summary.tiers.extended, ...summary.tiers.experimental];
  const listed = views.filter((v) => all || v.visibleInHelp);
  const rowOf = (v: ISurfaceCommandView) => index.byPath.get(v.command)?.catalogEntry;
  const inExplainFamily = (v: ISurfaceCommandView): boolean => {
    const row = rowOf(v);
    return row !== undefined && isExplainFamily(row);
  };
  const explainOnly = (v: ISurfaceCommandView): boolean => {
    if (all) return false;
    const row = rowOf(v);
    return row !== undefined && isExplainFamily(row) && !defaultShowInHelp(row);
  };

  // Registration order (init, inspect, doctor, …) — the order the top-level
  // list has always had — then alphabetical.
  const rank = new Map<string, number>();
  for (const name of [...registry.list().map((c) => c.name), ...registry.listGroups()]) {
    if (!rank.has(name)) rank.set(name, rank.size);
  }
  const headRank = (path: string): number => rank.get(path.split(' ')[0] ?? '') ?? Number.MAX_SAFE_INTEGER;
  const byRegistration = (a: ISurfaceCommandView, b: ISurfaceCommandView): number =>
    headRank(a.command) - headRank(b.command) || a.command.localeCompare(b.command);
  const line = (v: ISurfaceCommandView, width: number): string =>
    `  ${v.command.padEnd(width)} — ${firstSentence(v.description) || '(no description)'}${all ? helpAnnotation(v) : ''}\n`;

  let out = 'SharkCraft CLI — structured project intelligence for AI coding agents\n';
  out += 'Usage: shrk [--cwd <dir>] <command> [...args]\n';

  const main = listed.filter((v) => v.dispatch !== CommandDispatchKind.Meta && !explainOnly(v));
  out += header('Top-level commands');
  for (const v of main.filter((m) => !m.command.includes(' ')).sort(byRegistration)) out += line(v, 10);
  if (!all) {
    const hiddenCount = views.filter((v) => v.dispatch !== CommandDispatchKind.Meta && !v.visibleInHelp).length;
    if (hiddenCount > 0) {
      out +=
        `\n  …and ${hiddenCount} more hidden from default help (not on the curated surface, or hidden / gated by ` +
        "this repository's surface config). Run `shrk --full-help --all` to see them, or `shrk surface list` to browse by tier.\n";
    }
  }

  const groups = new Map<string, ISurfaceCommandView[]>();
  for (const v of main) {
    const head = v.command.split(' ')[0] ?? '';
    if (!v.command.includes(' ') || head.length === 0) continue;
    const members = groups.get(head) ?? [];
    members.push(v);
    groups.set(head, members);
  }
  const aliasesByCanonical = new Map<string, string[]>();
  for (const [alias, canonical] of registry.listGroupAliases().entries()) {
    const list = aliasesByCanonical.get(canonical) ?? [];
    list.push(alias);
    aliasesByCanonical.set(canonical, list);
  }
  const heads = [...groups.keys()].sort((a, b) => headRank(a) - headRank(b) || a.localeCompare(b));
  for (const head of heads) {
    const members = (groups.get(head) ?? []).sort((a, b) => a.command.localeCompare(b.command));
    const aliases = aliasesByCanonical.get(head) ?? [];
    out += header(`shrk ${head} <sub>${aliases.length ? ` (also: ${aliases.join(', ')})` : ''}`);
    const width = Math.min(28, Math.max(...members.map((m) => m.command.length)));
    for (const v of members) out += line(v, width);
  }

  // Explain / dry-run family — several carry an Advanced surface, so they are
  // not rent-paying, yet this section is WHY `visibleInHelp` counts them: they
  // show what a gate, ranker, or graph SEES before you act.
  const explain = listed.filter(inExplainFamily).sort((a, b) => a.command.localeCompare(b.command));
  if (explain.length > 0) {
    out += header('Inspect / explain (dry-run what a gate, ranker, or graph sees)');
    for (const v of explain) out += line(v, 24);
    out += '  (also: shrk check wiring --explain <ruleId>)\n';
  }

  const meta = listed.filter((v) => v.dispatch === CommandDispatchKind.Meta);
  if (meta.length > 0) {
    out += header('Meta flags');
    for (const v of meta) out += line(v, 12);
  }

  out += '\nRun `shrk help <command>` for detailed usage.\n';
  return out;
}

/** Bare `help` / `--help` (start screen) and `--full-help [--all]`, over the repository's surface. */
async function runListing(registry: CommandRegistry, args: IHelpArgs, wantsFull: boolean): Promise<number> {
  const { summary, note } = await helpSurface(registry, resolveCwd({ ...args, multiFlags: new Map() }));
  if (note) process.stderr.write(note);
  if (!wantsFull) {
    process.stdout.write(renderStartScreen(startScreenFilter(summary)));
    return 0;
  }
  process.stdout.write(renderFullHelp(registry, summary, args.flags.get('all') === true));
  return 0;
}

export function makeHelpCommand(registry: CommandRegistry) {
  return {
    name: 'help',
    description: 'Show CLI help. Bare `shrk help` prints a short start screen — pass `--full` for the long catalog.',
    usage: 'shrk help [<command>] [--full [--all]]  ·  shrk <command> [...] --help | -h  (anywhere before `--`; runs nothing)',
    // Topic help is synchronous (it reads only the command index); the start
    // screen and `--full-help` read the repository's surface, so they are async.
    run(args: IHelpArgs): number | Promise<number> {
      const requested = args.positional[0];
      const wantsFull =
        args.flags.get('full') === true ||
        args.flags.get('verbose') === true ||
        args.flags.get('full-help') === true;
      if (requested) {
        // Multi-segment help. `shrk help "pack author"` or
        // positional args ["pack", "author"] resolve through the trie.
        const tokens = args.positional[0]?.includes(' ')
          ? args.positional[0]!.split(/\s+/).filter(Boolean)
          : args.positional.filter(Boolean);
        const { handler, matchedPath, node } = registry.resolve(tokens);
        if (matchedPath.length === 0 && tokens.length > 0) {
          // Unknown topic: the descent matched NOTHING and stopped at the root
          // (which carries every top-level verb as a child). Do NOT fall through
          // to the group-listing branch below — that reprints the entire real
          // catalog re-prefixed with the bogus token, a false self-discovery
          // that exits 0. Error out honestly instead, with a did-you-mean when
          // a real topic is a near-typo of the request.
          const attempt = tokens.join(' ');
          const index = helpIndex(registry);
          // The trie matched nothing, but the INDEX may still know the path
          // under an alias spelling or as a folded variant.
          const viaIndex = renderIndexHelp(index, tokens);
          if (viaIndex !== undefined) {
            process.stdout.write(viaIndex);
            return 0;
          }
          process.stderr.write(`no such help topic: '${attempt}'\n`);
          const suggestion =
            nearest(attempt, realHelpTopics(index)) ?? nearest(attempt, indexHelpPaths(index));
          if (suggestion) process.stderr.write(`Did you mean: ${suggestion}?\n`);
          return 1;
        }
        // A tail the trie did not consume (`graph importers`, `check wiring`,
        // `templates lst`) is answered by the INDEX alone: a declared or
        // catalogued subverb prints its own help; anything else is an unknown
        // topic (exit 1) — never the parent group's listing at exit 0.
        if (tokens.length > matchedPath.length) {
          const index = helpIndex(registry);
          const indexHelp = renderIndexHelp(index, tokens);
          if (indexHelp !== undefined) {
            process.stdout.write(indexHelp);
            return 0;
          }
          const attempt = tokens.join(' ');
          process.stderr.write(`no such help topic: '${attempt}'\n`);
          const near = nearest(attempt, indexHelpPaths(index));
          if (near) process.stderr.write(`Did you mean: shrk help ${near}?\n`);
          return 1;
        }
        if (handler && matchedPath.join(' ') === tokens.join(' ') && node.children.size === 0) {
          // Exact match on a callable command.
          const canonical = registry.listCommandAliases().get(tokens[0]!);
          process.stdout.write(`${matchedPath.join(' ')} — ${handler.description}\n${handler.usage}\n`);
          const extra = EXTRA_HELP_LINES[matchedPath.join(' ')];
          if (extra) process.stdout.write(extra.join('\n') + '\n');
          if (canonical && tokens.length === 1) {
            process.stdout.write(`(alias for: ${canonical})\n`);
          }
          return 0;
        }
        if (node.children.size > 0) {
          // It's a group (with or without its own handler). List children.
          const aliasNote =
            matchedPath.length === 1 && registry.listGroupAliases().get(tokens[0]!) !== undefined
              ? ` (alias for: ${registry.listGroupAliases().get(tokens[0]!)})`
              : '';
          const groupLabel = matchedPath.length > 0 ? matchedPath.join(' ') : tokens.join(' ');
          process.stdout.write(header(`shrk ${groupLabel}${aliasNote}`));
          if (handler) {
            process.stdout.write(`  (this group is itself callable)\n`);
            process.stdout.write(`  ${groupLabel.padEnd(20)} — ${handler.description}\n`);
            process.stdout.write(`      ${handler.usage}\n\n`);
          }
          for (const [name, child] of node.children) {
            if (child.handler) {
              process.stdout.write(`  ${groupLabel} ${name.padEnd(12)} — ${child.handler.description}\n`);
              process.stdout.write(`      ${child.handler.usage}\n`);
            } else if (child.children.size > 0) {
              // Nested subgroup — show one-line summary.
              const verbList = [...child.children.keys()].slice(0, 4).join(', ');
              process.stdout.write(`  ${groupLabel} ${name.padEnd(12)} — subgroup: ${verbList}…\n`);
            }
          }
          return 0;
        }
        // The trie could not resolve the full path, but the INDEX may still
        // list it. Verbs like `check wiring` are dispatched from inside their
        // parent's handler on a positional, so they are real, callable and
        // documented — yet never trie nodes. Falling through to "Unknown
        // command" made an entire documented surface look non-existent.
        const index = helpIndex(registry);
        const indexHelp = renderIndexHelp(index, tokens);
        if (indexHelp !== undefined) {
          process.stdout.write(indexHelp);
          return 0;
        }
        process.stderr.write(`no such help topic: '${tokens.join(' ')}'\n`);
        const near = nearest(tokens.join(' '), indexHelpPaths(index));
        if (near) process.stderr.write(`Did you mean: shrk help ${near}?\n`);
        return 1;
      }
      // No topic: the start screen or `--full-help`, over THIS repository's
      // surface (the one visibility authority — see renderFullHelp).
      return runListing(registry, args, wantsFull);
    },
  };
}
