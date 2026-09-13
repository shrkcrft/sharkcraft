import { createHash } from 'node:crypto';
import {
  CommandAudience,
  CommandTier,
  defaultShowInHelp,
  isExplainFamily,
  type ICommandCatalogEntry,
} from '../commands/command-catalog.ts';
import { CommandDispatchKind } from './command-dispatch-kind.ts';
import type { ICommandIndexEntry } from './command-index-entry.ts';
import { buildCommandIndex, cleanCommandPath, getActiveCommandIndex } from './command-index.ts';
import type { ICommandIndex } from './i-command-index.ts';
import type { ISurfaceDenial } from './i-surface-denial.ts';
import { SurfaceLayer } from './surface-layer.ts';
import { firstMatchingSelector, matchesSurfaceSelector } from './surface-selector.ts';
import {
  BOOTSTRAP_COMMANDS,
  isBootstrapFamily,
  isCallable,
  isVisibleInDefaultHelp,
  resolveTier,
  resolveTierForPath,
  TierSource,
  type ITierResolution,
  type ITierResolverContext,
} from './tier.ts';

/**
 * v2 (round 11): the summary iterates the COMMAND INDEX — every dispatchable
 * verb, subverb and meta flag — instead of the catalog, and each row carries
 * its real description, usage, dispatch kind, audience and folded flag
 * variants. v1 listed catalog rows only (75 registered verbs were missing) and
 * printed one placeholder sentence for every extended row.
 */
export const SURFACE_SUMMARY_SCHEMA = 'sharkcraft.surface.v2';

/** Per-command snapshot used in {@link ISurfaceSummary}. */
export interface ISurfaceCommandView {
  command: string;
  tier: CommandTier;
  source: TierSource;
  detail?: string;
  /** One-line description (catalog ?? declared subverb ?? handler). */
  description: string;
  /** Usage line, when the handler or a declared subverb carries one. */
  usage?: string;
  /** How the command dispatches (trie handler, internal subverb, meta flag). */
  dispatch: CommandDispatchKind;
  /** True when a catalog row documents the command. */
  catalogued: boolean;
  audience: readonly CommandAudience[];
  /** Catalog rows folded in because they only add flags / placeholders. */
  variants: readonly string[];
  /** Whether the command is callable in this project's surface configuration. */
  callable: boolean;
  /**
   * Whether the command shows in `--full-help`. THE answer — `--full-help`
   * renders exactly the views that say `true` (round 11 §5.1#3).
   */
  visibleInHelp: boolean;
  /** True if a `surface.hidden[]` selector names the command. */
  hidden: boolean;
  /** True if a `surface.enabled[]` selector names the command. */
  enabled: boolean;
  /** True if a `surface.disabled[]` selector DENIES the command (source `disabled`). */
  disabled: boolean;
  /** The deny selector and its layer, when `disabled`. */
  deniedBy?: ISurfaceDenial;
  /** Pack contribution source, if any. */
  pack?: string;
}

export interface ISurfaceTotals {
  core: number;
  extended: number;
  experimental: number;
  /** Rows visible in `--full-help` (core + extended visibleInHelp). */
  visible: number;
  /** Every callable row (core + extended + enabled experimental). */
  callable: number;
  /** Dispatchable rows no catalog row documents (`commands doctor` warns on each). */
  uncatalogued: number;
}

export interface ISurfaceSummary {
  schema: typeof SURFACE_SUMMARY_SCHEMA;
  /**
   * True when the rows are the dispatch table (built from the command
   * registry). False only for a registry-less engine call, where the rows are
   * the catalog relabelled — a partial inventory, and said so.
   */
  registryBacked: boolean;
  tiers: {
    core: readonly ISurfaceCommandView[];
    extended: readonly ISurfaceCommandView[];
    experimental: readonly ISurfaceCommandView[];
  };
  totals: ISurfaceTotals;
  /**
   * Warnings — e.g. a `surface.enabled` entry that doesn't match any
   * command, or an attempt to hide or disable a core command.
   */
  warnings: readonly ISurfaceWarning[];
  /** Stable hash of (index + context). Used in test snapshots. */
  hash: string;
}

export interface ISurfaceWarning {
  command: string;
  code:
    | 'unknown-command'
    | 'cannot-hide-core'
    | 'cannot-disable-core'
    | 'enable-noop'
    | 'enable-disable-conflict'
    | 'tier-override-conflict';
  message: string;
}

/** The `surface{}` lists every selector warning is checked against, in report order. */
const SELECTOR_FIELDS = ['enabled', 'hidden', 'disabled'] as const;

/**
 * Build the canonical surface summary used by `shrk surface list`
 * (text + JSON), the `--about` landing, `--help` / `--full-help`, the CLI
 * surface gate and the MCP gating layer.
 *
 * `index` defaults to the ACTIVE command index (the registry this CLI run
 * dispatches from). Outside `runCli` it falls back to the catalog, relabelled
 * (`registryBacked: false`).
 *
 * Deterministic: same context + index → same summary, byte-for-byte. The
 * `hash` field is the SHA-256 prefix of the canonical JSON form (sans the
 * hash itself) — useful for cache keys and snapshot tests.
 */
export function buildSurfaceSummary(
  context: ITierResolverContext,
  index: ICommandIndex = getActiveCommandIndex() ?? buildCommandIndex(),
): ISurfaceSummary {
  const core: ISurfaceCommandView[] = [];
  const extended: ISurfaceCommandView[] = [];
  const experimental: ISurfaceCommandView[] = [];
  const warnings: ISurfaceWarning[] = [];

  // Every spelling a selector may name: paths, alias spellings, flag variants.
  const knownNames: string[] = [...BOOTSTRAP_COMMANDS];

  for (const entry of index.entries) {
    knownNames.push(entry.path, ...entry.variants, ...entry.aliases);
    const view = makeCommandView(entry, context, warnings);
    pushIntoBucket(view, core, extended, experimental);
  }

  // Bootstrap names the index does not list (defensive: every bootstrap
  // command is a registered handler or a meta flag today).
  const indexed = new Set(knownNames);
  for (const bootstrap of BOOTSTRAP_COMMANDS) {
    if (index.entries.some((e) => e.path === bootstrap || e.aliases.includes(bootstrap))) continue;
    if (!indexed.has(bootstrap)) continue;
    core.push({
      command: bootstrap,
      tier: CommandTier.Core,
      source: TierSource.Bootstrap,
      detail: 'bootstrap meta-flag',
      description: 'Bootstrap meta flag.',
      dispatch: CommandDispatchKind.Meta,
      catalogued: false,
      audience: [CommandAudience.Human],
      variants: [],
      callable: true,
      visibleInHelp: true,
      hidden: false,
      enabled: false,
      disabled: false,
    });
  }

  // Sort each bucket alphabetically for stable output.
  const sortByName = (a: ISurfaceCommandView, b: ISurfaceCommandView) =>
    a.command.localeCompare(b.command);
  core.sort(sortByName);
  extended.sort(sortByName);
  experimental.sort(sortByName);

  // A selector that names nothing is a silent no-op — say so. Group selectors
  // (`bundle *`) go through the same matcher the resolver uses.
  for (const field of SELECTOR_FIELDS) {
    for (const selector of new Set(context.surfaceConfig?.[field] ?? [])) {
      if (!knownNames.some((name) => matchesSurfaceSelector(selector, name))) {
        warnings.push({
          command: selector,
          code: 'unknown-command',
          message: `surface.${field}[] references unknown command: ${selector}`,
        });
      }
    }
  }

  const all = [...core, ...extended, ...experimental];
  const totals: ISurfaceTotals = {
    core: core.length,
    extended: extended.length,
    experimental: experimental.length,
    visible: core.length + extended.filter((c) => c.visibleInHelp).length,
    callable: all.filter((c) => c.callable).length,
    uncatalogued: all.filter((c) => !c.catalogued && c.dispatch !== CommandDispatchKind.Meta)
      .length,
  };

  const summaryWithoutHash = {
    schema: SURFACE_SUMMARY_SCHEMA as typeof SURFACE_SUMMARY_SCHEMA,
    registryBacked: index.registryBacked,
    tiers: { core, extended, experimental },
    totals,
    warnings,
  };
  const hash = createHash('sha256')
    .update(JSON.stringify(summaryWithoutHash))
    .digest('hex')
    .slice(0, 16);

  return { ...summaryWithoutHash, hash };
}

function makeCommandView(
  entry: ICommandIndexEntry,
  context: ITierResolverContext,
  warnings: ISurfaceWarning[],
): ISurfaceCommandView {
  const name = entry.path;
  const names = [name, ...entry.aliases];
  const catalogRow = entry.catalogEntry;
  const resolution: ITierResolution =
    entry.dispatch === CommandDispatchKind.Meta
      ? { tier: CommandTier.Core, source: TierSource.Bootstrap, detail: 'bootstrap meta-flag' }
      : resolveTierForPath(name, catalogRow, context, entry.aliases);
  const isHidden = firstMatchingSelector(context.surfaceConfig?.hidden, names) !== undefined;
  const isEnabled = firstMatchingSelector(context.surfaceConfig?.enabled, names) !== undefined;
  const denySelector = firstMatchingSelector(context.surfaceConfig?.disabled, names);

  // Cross-check the config against the derived tier.
  if (resolution.tier === CommandTier.Core) {
    if (isHidden) {
      warnings.push({
        command: name,
        code: 'cannot-hide-core',
        message: `Cannot hide core command: ${name}. Remove from surface.hidden.`,
      });
    }
    if (isEnabled) {
      // Enabling a core command is harmless but pointless.
      warnings.push({
        command: name,
        code: 'enable-noop',
        message: `Enabling a core command is a no-op: ${name}`,
      });
    }
  }
  // A deny that could not apply: a core command, or a bootstrap command's
  // subverb (the verbs that undo a deny must stay reachable).
  if (
    denySelector !== undefined &&
    resolution.source !== TierSource.Disabled &&
    (resolution.tier === CommandTier.Core || isBootstrapFamily(name))
  ) {
    warnings.push({
      command: name,
      code: 'cannot-disable-core',
      message: `Cannot disable core command: ${name} (surface.disabled '${denySelector}'). It stays callable.`,
    });
  }
  // A config deny and a config enable naming the same command: the deny wins.
  if (resolution.deniedBy?.origin === SurfaceLayer.Config) {
    const explicit = context.explicitSurface ?? context.surfaceConfig;
    if (firstMatchingSelector(explicit?.enabled, names) !== undefined) {
      warnings.push({
        command: name,
        code: 'enable-disable-conflict',
        message: `surface.disabled ('${resolution.deniedBy.selector}') and surface.enabled both name ${name} — disabled wins.`,
      });
    }
  }

  // Cross-check explicit override against the resolver. If the catalog
  // says Experimental but the resolver promoted to Core (spine /
  // bootstrap), surface a warning so the override is corrected.
  if (
    catalogRow?.tier !== undefined &&
    catalogRow.tier !== resolution.tier &&
    resolution.source !== TierSource.Override &&
    resolution.source !== TierSource.Disabled &&
    resolution.source !== TierSource.ToolMaintenance
  ) {
    warnings.push({
      command: name,
      code: 'tier-override-conflict',
      message: `Catalog declares tier=${catalogRow.tier} but mechanical derivation resolved to ${resolution.tier} (${resolution.source}). Remove the override.`,
    });
  }

  const view: ISurfaceCommandView = {
    command: name,
    tier: resolution.tier,
    source: resolution.source,
    description: entry.description,
    ...(entry.usage ? { usage: entry.usage } : {}),
    dispatch: entry.dispatch,
    catalogued: entry.catalogued,
    audience: entry.audience,
    variants: entry.variants,
    callable: isCallable(resolution),
    visibleInHelp: visibleInHelp(entry, catalogRow, resolution, isHidden),
    hidden: isHidden,
    enabled: isEnabled,
    disabled: resolution.source === TierSource.Disabled,
  };
  if (resolution.deniedBy) view.deniedBy = resolution.deniedBy;
  if (resolution.detail) view.detail = resolution.detail;
  const pack = context.packContributions.get(name);
  if (pack) view.pack = pack;
  return view;
}

/**
 * THE `--help` visibility rule. `--full-help` lists exactly the views this
 * returns `true` for: the rent-paying catalog surface (`defaultShowInHelp`)
 * plus the explain / dry-run family `--full-help` lists in its own section —
 * both subject to the tier (experimental is never listed) and to
 * `surface.hidden`. Help used to decide from the catalog alone, so
 * `surface.hidden` / profiles / gating never reached it and `surface explain`
 * disagreed with the actual help output.
 */
function visibleInHelp(
  entry: ICommandIndexEntry,
  catalogRow: ICommandCatalogEntry | undefined,
  resolution: ITierResolution,
  isHidden: boolean,
): boolean {
  if (entry.dispatch === CommandDispatchKind.Meta) return true;
  // Help listings are catalog-curated: an uncatalogued command runs, but has
  // no row for `--help` to surface.
  if (!catalogRow) return false;
  if (!isVisibleInDefaultHelp(resolution, isHidden)) return false;
  return defaultShowInHelp(catalogRow) || isExplainFamily(catalogRow);
}

function pushIntoBucket(
  view: ISurfaceCommandView,
  core: ISurfaceCommandView[],
  extended: ISurfaceCommandView[],
  experimental: ISurfaceCommandView[],
): void {
  switch (view.tier) {
    case CommandTier.Core:
      core.push(view);
      break;
    case CommandTier.Extended:
      extended.push(view);
      break;
    case CommandTier.Experimental:
      experimental.push(view);
      break;
  }
}

/**
 * Look up a single command's view from a summary. Accepts the command path,
 * a folded flag variant (`architecture violations --changed-only`) or an alias
 * spelling — the shapes callers (the surface gate, MCP `cliCommand`) hold.
 */
export function findCommandInSummary(
  summary: ISurfaceSummary,
  command: string,
): ISurfaceCommandView | undefined {
  const views = [...summary.tiers.core, ...summary.tiers.extended, ...summary.tiers.experimental];
  const want = command.trim();
  const exact = views.find((c) => c.command === want);
  if (exact) return exact;
  const clean = cleanCommandPath(want);
  return (
    (clean.length > 0 ? views.find((c) => c.command === clean) : undefined) ??
    views.find((c) => c.variants.includes(want))
  );
}

/** Resolve a single tier given a context (no summary needed). */
export function resolveTierForCommand(
  entry: ICommandCatalogEntry,
  context: ITierResolverContext,
): ITierResolution {
  return resolveTier(entry, context);
}
