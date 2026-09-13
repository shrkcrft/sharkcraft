import {
  COMMAND_CATALOG,
  CommandAudience,
  commandAudience,
  type ICommandCatalogEntry,
} from '../commands/command-catalog.ts';
import type { CommandRegistry, ICommandHandler } from '../command-registry.ts';
import type { PositionalMode } from '../dispatch/positional-mode.ts';
import type { ISubverbSpec } from '../dispatch/subverb-spec.ts';
import { CommandDispatchKind } from './command-dispatch-kind.ts';
import type { ICommandIndexEntry } from './command-index-entry.ts';
import type { ICommandIndex } from './i-command-index.ts';

/**
 * THE command index — the one answer to "does this command / subverb / meta
 * flag exist, what does it do, who is it for".
 *
 * Before round 11 there were three disagreeing inventories: the dispatch trie
 * (326 handler paths), COMMAND_CATALOG (442 rows, 55 of them flag variants of
 * another row) and help's own catalog walk. `surface list` enumerated the
 * catalog, so 75 registered verbs were absent from "the callable-command
 * inventory", and a command-string check against it would have deleted correct
 * commands. The index is built from the registry (what actually dispatches)
 * and JOINED with the catalog (what documents it):
 *
 *   (a) every `registry.listAll()` path                  → `Trie`
 *   (b) every subverb a handler declares (`subverbs`)    → `Subverb` (declared)
 *   (c) every catalog path dispatched internally by a
 *       real handler (`check wiring`, `graph status`)    → `Subverb`
 *   (d) catalog-documented command groups (`paths`)      → `Trie`
 *   (e) the bootstrap meta flags                         → `Meta`
 *
 * Catalog rows that only add flags or placeholders fold into `variants`.
 * `surface list`, `help`, `commands doctor`, the surface gate and the
 * command-string resolver all read this — never COMMAND_CATALOG directly.
 */

/** Meta flags `runCliInner` handles before dispatch. Always callable. */
export const META_COMMANDS: readonly { path: string; description: string; usage: string }[] =
  Object.freeze([
    {
      path: '--about',
      description: 'What shrk is and is not — the in-binary philosophy summary.',
      usage: 'shrk --about',
    },
    {
      path: '--full-help',
      description: 'Long help: every visible command (add --all for the whole catalog).',
      usage: 'shrk --full-help [--all]',
    },
    {
      path: '--help',
      description: 'The short start screen (same as `shrk help`).',
      usage: 'shrk --help',
    },
    {
      path: '--version',
      description: 'Print the installed shrk version.',
      usage: 'shrk --version',
    },
  ]);

const COMMAND_WORD = /^[a-z0-9][a-z0-9-]*$/i;

/** A token that can be a command-path segment (not a flag, placeholder, quote or path). */
export function isCommandWord(token: string): boolean {
  return COMMAND_WORD.test(token);
}

/**
 * The command path a catalog `command` string documents: its leading run of
 * command words, stopping at the first flag, placeholder, quoted argument or
 * path (`impact graph <impact.json>` → `impact graph`,
 * `architecture violations --changed-only` → `architecture violations`).
 */
export function cleanCommandPath(command: string): string {
  const out: string[] = [];
  for (const token of command.trim().split(/\s+/)) {
    if (!isCommandWord(token)) break;
    out.push(token);
  }
  return out.join(' ');
}

function groupCatalogRows(catalog: readonly ICommandCatalogEntry[]): Map<string, ICommandCatalogEntry[]> {
  const byPath = new Map<string, ICommandCatalogEntry[]>();
  for (const row of catalog) {
    const path = cleanCommandPath(row.command);
    if (path.length === 0) continue;
    const list = byPath.get(path) ?? [];
    list.push(row);
    byPath.set(path, list);
  }
  return byPath;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))].sort();
}

interface IEntryInput {
  path: string;
  dispatch: CommandDispatchKind;
  rows?: readonly ICommandCatalogEntry[] | undefined;
  handler?: ICommandHandler | undefined;
  subverb?: ISubverbSpec | undefined;
  parent?: string | undefined;
  /** The path a declared subverb's own aliases are spelled under (default: `parent`). */
  aliasParent?: string | undefined;
  declared?: boolean | undefined;
  aliases?: readonly string[] | undefined;
}

function makeEntry(input: IEntryInput): ICommandIndexEntry {
  const rows = input.rows ?? [];
  const base = rows.find((r) => r.command.trim() === input.path) ?? rows[0];
  const variants = sortedUnique(
    rows.map((r) => r.command.trim()).filter((c) => c !== input.path),
  );
  const description =
    base?.description ?? input.subverb?.description ?? input.handler?.description ?? '';
  const usage = input.subverb?.usage ?? input.handler?.usage;
  const aliasParent = input.aliasParent ?? input.parent;
  const subverbAliases = (input.subverb?.aliases ?? []).map((a) =>
    aliasParent ? `${aliasParent} ${a}` : a,
  );
  const aliases = sortedUnique([
    ...(base?.aliases ?? []),
    ...(input.aliases ?? []),
    ...subverbAliases,
  ]);
  const positionals: PositionalMode | undefined =
    input.subverb?.positionals ?? input.handler?.positionals;
  return {
    path: input.path,
    tokens: input.path.split(' '),
    dispatch: input.dispatch,
    description,
    ...(usage ? { usage } : {}),
    catalogued: rows.length > 0,
    ...(base ? { catalogEntry: base } : {}),
    variants,
    aliases,
    audience: base ? commandAudience(base) : [CommandAudience.Human],
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    ...(input.declared !== undefined ? { declared: input.declared } : {}),
    ...(positionals !== undefined ? { positionals } : {}),
  };
}

/** Top-level alias spellings of `path` (`playbook list` for `playbooks list`). */
function aliasSpellings(
  path: readonly string[],
  topAliases: ReadonlyMap<string, readonly string[]>,
): string[] {
  const head = path[0];
  if (head === undefined) return [];
  return (topAliases.get(head) ?? []).map((alias) => [alias, ...path.slice(1)].join(' '));
}

function collectTopAliases(registry: CommandRegistry): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (alias: string, canonical: string): void => {
    const list = out.get(canonical) ?? [];
    if (!list.includes(alias)) list.push(alias);
    out.set(canonical, list);
  };
  for (const [alias, canonical] of registry.listGroupAliases()) add(alias, canonical);
  for (const [alias, canonical] of registry.listCommandAliases()) add(alias, canonical);
  return out;
}

/**
 * Build the command index. With a registry it is the dispatch table joined
 * with the catalog; without one it degrades to the catalog, relabelled
 * (`registryBacked: false`, every entry `Catalog`) rather than passed off as
 * the dispatch table.
 *
 * `catalog` defaults to COMMAND_CATALOG; a test passes its own rows to prove a
 * join (an undeclared internal subverb) against a registry of its own.
 */
export function buildCommandIndex(
  registry?: CommandRegistry,
  catalog: readonly ICommandCatalogEntry[] = COMMAND_CATALOG,
): ICommandIndex {
  const rowsByPath = groupCatalogRows(catalog);
  const entries = new Map<string, ICommandIndexEntry>();

  if (registry) {
    const topAliases = collectTopAliases(registry);
    const all = registry.listAll();
    // (a) every registered handler path.
    for (const { path, handler } of all) {
      const p = path.join(' ');
      entries.set(
        p,
        makeEntry({
          path: p,
          dispatch: CommandDispatchKind.Trie,
          rows: rowsByPath.get(p),
          handler,
          aliases: aliasSpellings(path, topAliases),
        }),
      );
    }
    // (b) subverbs a handler declares — nested ones too (`search tuning list`).
    // A real trie child of the same name wins. `parent` stays the handler that
    // dispatches the whole chain; aliases are spelled under the direct parent.
    const addDeclared = (
      handlerPath: readonly string[],
      parentPath: readonly string[],
      specs: readonly ISubverbSpec[],
    ): void => {
      for (const subverb of specs) {
        const tokens = [...parentPath, subverb.name];
        const p = tokens.join(' ');
        if (!entries.has(p)) {
          entries.set(
            p,
            makeEntry({
              path: p,
              dispatch: CommandDispatchKind.Subverb,
              rows: rowsByPath.get(p),
              subverb,
              parent: handlerPath.join(' '),
              aliasParent: parentPath.join(' '),
              declared: true,
              aliases: aliasSpellings(tokens, topAliases),
            }),
          );
        }
        if (subverb.subverbs) addDeclared(handlerPath, tokens, subverb.subverbs);
      }
    };
    for (const { path, handler } of all) {
      addDeclared(path, path, handler.subverbs ?? []);
    }
    // (c)/(d) catalog paths the trie does not list verbatim.
    for (const [p, rows] of rowsByPath) {
      if (entries.has(p)) continue;
      const res = registry.resolve(p.split(' '));
      if (res.matchedPath.length === 0) continue; // nothing dispatches it — `commands doctor` reports the row
      const canonical = [...res.matchedPath, ...res.rest].join(' ');
      const existing = entries.get(canonical);
      if (existing) {
        // An alias spelling of a path already indexed (`playbook list`).
        entries.set(canonical, {
          ...existing,
          catalogued: true,
          ...(existing.catalogEntry ? {} : rows[0] ? { catalogEntry: rows[0] } : {}),
          variants: sortedUnique([...existing.variants, ...rows.map((r) => r.command.trim())]),
          aliases: sortedUnique([...existing.aliases, p]),
        });
        continue;
      }
      if (res.rest.length === 0) {
        // (d) A documented command group with no handler of its own.
        if (res.node.children.size > 0) {
          entries.set(
            canonical,
            makeEntry({ path: canonical, dispatch: CommandDispatchKind.Trie, rows }),
          );
        }
        continue;
      }
      // (c) Dispatched internally by the deepest matched handler. A pure group
      // node cannot dispatch a positional, so its "subverb" is not real.
      if (!res.handler) continue;
      entries.set(
        canonical,
        makeEntry({
          path: canonical,
          dispatch: CommandDispatchKind.Subverb,
          rows,
          parent: res.matchedPath.join(' '),
          declared: false,
        }),
      );
    }
  } else {
    for (const [p, rows] of rowsByPath) {
      entries.set(p, makeEntry({ path: p, dispatch: CommandDispatchKind.Catalog, rows }));
    }
  }

  // (e) bootstrap meta flags.
  for (const meta of META_COMMANDS) {
    if (entries.has(meta.path)) continue;
    const rows = rowsByPath.get(meta.path);
    entries.set(meta.path, {
      path: meta.path,
      tokens: [meta.path],
      dispatch: CommandDispatchKind.Meta,
      description: rows?.[0]?.description ?? meta.description,
      usage: meta.usage,
      catalogued: (rows?.length ?? 0) > 0,
      ...(rows?.[0] ? { catalogEntry: rows[0] } : {}),
      variants: [],
      aliases: [],
      audience: [CommandAudience.Human, CommandAudience.Agent],
    });
  }

  const sorted = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    entries: sorted,
    byPath: new Map(sorted.map((e) => [e.path, e])),
    registryBacked: registry !== undefined,
    ...(registry ? { registry } : {}),
  };
}

/** The entry at `path`, or the entry a folded variant / alias spelling belongs to. */
export function findCommandIndexEntry(
  index: ICommandIndex,
  command: string,
): ICommandIndexEntry | undefined {
  const exact = index.byPath.get(command.trim());
  if (exact) return exact;
  const clean = cleanCommandPath(command);
  const byClean = index.byPath.get(clean);
  if (byClean) return byClean;
  return index.entries.find((e) => e.aliases.includes(clean) || e.variants.includes(command.trim()));
}

/**
 * The known subverb names directly below `path`: the next token of every index
 * entry under it, at any depth (`ci scaffold gitlab` makes `scaffold` a known
 * subverb of `ci` even though `ci scaffold` has no row of its own). Sorted,
 * distinct.
 */
export function subverbNamesOf(index: ICommandIndex, path: string): string[] {
  const depth = path.length === 0 ? 0 : path.split(' ').length;
  const prefix = path.length === 0 ? '' : `${path} `;
  const out = new Set<string>();
  for (const e of index.entries) {
    if (e.tokens.length <= depth) continue;
    if (prefix.length > 0 && !e.path.startsWith(prefix)) continue;
    const name = e.tokens[depth];
    if (name !== undefined && !name.startsWith('-')) out.add(name);
  }
  return [...out].sort();
}

// ── The active index ──────────────────────────────────────────────────────
//
// `runCliInner` registers the registry it dispatches from, once per run, so a
// command (or a warm site feeding the inspector's command resolver) reads the
// SAME index without importing main.ts — which imports every command and would
// be circular. Built lazily: most runs never ask.

let activeRegistry: CommandRegistry | undefined;

const INDEX_BY_REGISTRY = new WeakMap<CommandRegistry, ICommandIndex>();

/**
 * The index of `registry` (over COMMAND_CATALOG), built once per registry and
 * shared — the dispatcher guard, the help intercept, `help` and the active
 * index all read the same object.
 */
export function commandIndexFor(registry: CommandRegistry): ICommandIndex {
  let index = INDEX_BY_REGISTRY.get(registry);
  if (!index) {
    index = buildCommandIndex(registry);
    INDEX_BY_REGISTRY.set(registry, index);
  }
  return index;
}

/** Called by `runCliInner` with the registry it dispatches from. */
export function setActiveCommandRegistry(registry: CommandRegistry | undefined): void {
  activeRegistry = registry;
}

/**
 * The index of the registry this CLI run dispatches from, or `undefined`
 * outside `runCli` (a direct engine call) — callers then degrade loudly
 * (`buildCommandIndex()` relabelled as the catalog, or no command resolver →
 * NOT VERIFIED), never to a silent guess.
 */
export function getActiveCommandIndex(): ICommandIndex | undefined {
  return activeRegistry ? commandIndexFor(activeRegistry) : undefined;
}
