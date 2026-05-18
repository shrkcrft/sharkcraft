import { createHash } from 'node:crypto';
import {
  CommandTier,
  COMMAND_CATALOG,
  defaultShowInHelp,
  type ICommandCatalogEntry,
} from '../commands/command-catalog.ts';
import {
  BOOTSTRAP_COMMANDS,
  isCallable,
  isVisibleInDefaultHelp,
  resolveTier,
  TierSource,
  type ITierResolution,
  type ITierResolverContext,
} from './tier.ts';

export const SURFACE_SUMMARY_SCHEMA = 'sharkcraft.surface.v1';

/** Per-command snapshot used in {@link ISurfaceSummary}. */
export interface ISurfaceCommandView {
  command: string;
  tier: CommandTier;
  source: TierSource;
  detail?: string;
  /** Whether the command is callable in this project's surface configuration. */
  callable: boolean;
  /** Whether the command shows in default `--help` output. */
  visibleInHelp: boolean;
  /** True if `surface.hidden[]` contains the command. */
  hidden: boolean;
  /** True if `surface.enabled[]` contains the command. */
  enabled: boolean;
  /** Pack contribution source, if any. */
  pack?: string;
}

export interface ISurfaceTotals {
  core: number;
  extended: number;
  experimental: number;
  /** Sum of (core + extended visibleInHelp). */
  visible: number;
  /** Sum of all callable commands (core + extended). */
  callable: number;
}

export interface ISurfaceSummary {
  schema: typeof SURFACE_SUMMARY_SCHEMA;
  tiers: {
    core: readonly ISurfaceCommandView[];
    extended: readonly ISurfaceCommandView[];
    experimental: readonly ISurfaceCommandView[];
  };
  totals: ISurfaceTotals;
  /**
   * Warnings — e.g. a `surface.enabled` entry that doesn't match any
   * catalog command, or an attempt to hide a core command.
   */
  warnings: readonly ISurfaceWarning[];
  /** Stable hash of (catalog + context). Used in test snapshots. */
  hash: string;
}

export interface ISurfaceWarning {
  command: string;
  code: 'unknown-command' | 'cannot-hide-core' | 'cannot-disable-core' | 'enable-noop' | 'tier-override-conflict';
  message: string;
}

/**
 * Build the canonical surface summary used by `shrk surface list`
 * (text + JSON), the `--about` landing, the help renderer's hidden-set,
 * and the MCP gating layer.
 *
 * Implementation note: deterministic. Same context + catalog → same
 * summary, byte-for-byte. The `hash` field is the SHA-256 prefix of
 * the canonical JSON form (sans the hash itself) — useful for cache
 * keys and snapshot tests.
 */
export function buildSurfaceSummary(
  context: ITierResolverContext,
): ISurfaceSummary {
  const core: ISurfaceCommandView[] = [];
  const extended: ISurfaceCommandView[] = [];
  const experimental: ISurfaceCommandView[] = [];
  const warnings: ISurfaceWarning[] = [];

  const hiddenSet = new Set(context.surfaceConfig?.hidden ?? []);
  const enabledSet = new Set(context.surfaceConfig?.enabled ?? []);

  const knownCommands = new Set<string>();

  for (const entry of COMMAND_CATALOG) {
    knownCommands.add(entry.command);
    const view = makeCommandView(entry, context, hiddenSet, enabledSet, warnings);
    pushIntoBucket(view, core, extended, experimental);
  }

  // Surface bootstrap meta-flags (e.g. `--about`) that aren't
  // ordinary catalog entries. They sit in core for visibility but have
  // no catalog row.
  for (const bootstrap of BOOTSTRAP_COMMANDS) {
    if (knownCommands.has(bootstrap)) continue;
    core.push({
      command: bootstrap,
      tier: CommandTier.Core,
      source: TierSource.Bootstrap,
      detail: 'bootstrap meta-flag',
      callable: true,
      visibleInHelp: true,
      hidden: false,
      enabled: false,
    });
  }

  // Sort each bucket alphabetically for stable output.
  const sortByName = (a: ISurfaceCommandView, b: ISurfaceCommandView) =>
    a.command.localeCompare(b.command);
  core.sort(sortByName);
  extended.sort(sortByName);
  experimental.sort(sortByName);

  // Audit warnings for config keys that don't correspond to anything.
  for (const name of enabledSet) {
    if (!knownCommands.has(name) && !BOOTSTRAP_COMMANDS.includes(name)) {
      warnings.push({
        command: name,
        code: 'unknown-command',
        message: `surface.enabled[] references unknown command: ${name}`,
      });
    }
  }
  for (const name of hiddenSet) {
    if (!knownCommands.has(name) && !BOOTSTRAP_COMMANDS.includes(name)) {
      warnings.push({
        command: name,
        code: 'unknown-command',
        message: `surface.hidden[] references unknown command: ${name}`,
      });
    }
  }

  const totals: ISurfaceTotals = {
    core: core.length,
    extended: extended.length,
    experimental: experimental.length,
    visible: core.length + extended.filter((c) => c.visibleInHelp).length,
    callable:
      core.length +
      extended.length +
      experimental.filter((c) => c.callable).length,
  };

  const summaryWithoutHash = {
    schema: SURFACE_SUMMARY_SCHEMA as typeof SURFACE_SUMMARY_SCHEMA,
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
  entry: ICommandCatalogEntry,
  context: ITierResolverContext,
  hiddenSet: ReadonlySet<string>,
  enabledSet: ReadonlySet<string>,
  warnings: ISurfaceWarning[],
): ISurfaceCommandView {
  const resolution = resolveTier(entry, context);
  const isHidden = hiddenSet.has(entry.command);
  const isEnabled = enabledSet.has(entry.command);

  // Cross-check the config against the derived tier.
  if (resolution.tier === CommandTier.Core) {
    if (isHidden) {
      warnings.push({
        command: entry.command,
        code: 'cannot-hide-core',
        message: `Cannot hide core command: ${entry.command}. Remove from surface.hidden.`,
      });
    }
    if (isEnabled) {
      // Enabling a core command is harmless but pointless.
      warnings.push({
        command: entry.command,
        code: 'enable-noop',
        message: `Enabling a core command is a no-op: ${entry.command}`,
      });
    }
  }

  // Cross-check explicit override against the resolver. If the catalog
  // says Experimental but the resolver promoted to Core (spine /
  // bootstrap), surface a warning so the override is corrected.
  if (
    entry.tier !== undefined &&
    entry.tier !== resolution.tier &&
    resolution.source !== TierSource.Override
  ) {
    warnings.push({
      command: entry.command,
      code: 'tier-override-conflict',
      message: `Catalog declares tier=${entry.tier} but mechanical derivation resolved to ${resolution.tier} (${resolution.source}). Remove the override.`,
    });
  }

  const view: ISurfaceCommandView = {
    command: entry.command,
    tier: resolution.tier,
    source: resolution.source,
    callable: isCallable(resolution),
    visibleInHelp:
      isVisibleInDefaultHelp(resolution, isHidden) && defaultShowInHelp(entry),
    hidden: isHidden,
    enabled: isEnabled,
  };
  if (resolution.detail) view.detail = resolution.detail;
  const pack = context.packContributions.get(entry.command);
  if (pack) view.pack = pack;
  return view;
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

/** Look up a single command's tier resolution from a summary. */
export function findCommandInSummary(
  summary: ISurfaceSummary,
  command: string,
): ISurfaceCommandView | undefined {
  return (
    summary.tiers.core.find((c) => c.command === command) ??
    summary.tiers.extended.find((c) => c.command === command) ??
    summary.tiers.experimental.find((c) => c.command === command)
  );
}

/** Resolve a single tier given a context (no summary needed). */
export function resolveTierForCommand(
  entry: ICommandCatalogEntry,
  context: ITierResolverContext,
): ITierResolution {
  return resolveTier(entry, context);
}
