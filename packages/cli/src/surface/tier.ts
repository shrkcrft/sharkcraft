import type { ISurfaceConfig } from '@shrkcrft/config';
import {
  CommandTier,
  type ICommandCatalogEntry,
} from '../commands/command-catalog.ts';

/**
 * Bootstrap commands. Always tier=Core regardless of any other
 * derivation rule. Listed here (and only here) so the rule is mechanical:
 * a fresh repo with NO `sharkcraft.config.ts` can always reach these.
 *
 * Tokens are catalog `command` strings (the same form as
 * {@link ICommandCatalogEntry.command}). Multi-token entries (e.g.
 * `pack author status`) are matched exactly.
 *
 * Brutally small set. Discovery verbs (`commands`, `start-here`) live
 * in extended tier; users find them via `shrk surface list` or `shrk
 * recommend`.
 */
export const BOOTSTRAP_COMMANDS: readonly string[] = Object.freeze([
  'init',
  'doctor',
  'recommend',
  'surface',
  'help',
  'version',
  // Meta verbs that must always work. `--about` is a top-level
  // meta flag handled in main.ts; included here for documentation
  // completeness so `surface list` surfaces it.
  '--about',
]);

/**
 * Source explanations for tier classification. Returned by the
 * resolver so `shrk surface explain <name>` can describe why a
 * command's tier is what it is.
 */
export enum TierSource {
  Bootstrap = 'bootstrap',
  Spine = 'spine',
  PackContribution = 'pack-contribution',
  Override = 'override',
  Hidden = 'hidden-flag',
  Default = 'default',
}

export interface ITierResolution {
  /** Resolved tier (post-derivation, post-config). */
  tier: CommandTier;
  /** Why the tier resolved that way. */
  source: TierSource;
  /** Human-readable detail (e.g. "in engine.feature-dev spine pipeline"). */
  detail?: string;
  /** True if the user's surface config flipped the default. */
  configApplied?: boolean;
}

export interface ITierResolverContext {
  /** Catalog command names ({@link ICommandCatalogEntry.command}) referenced by spine pipelines. */
  spineCommands: ReadonlySet<string>;
  /** Catalog command names contributed by loaded packs (pack-contributed commands). */
  packContributions: ReadonlyMap<string, string>; // command → pack name
  /** User's `sharkcraft.config.ts surface{}` block (may be undefined for a fresh repo). */
  surfaceConfig: ISurfaceConfig | undefined;
}

/**
 * Mechanically derive a command's tier.
 *
 * Resolution order (HIGHEST wins, never demotes Core):
 *
 *   1. Bootstrap set → Core.
 *   2. Spine pipeline reference → Core.
 *   3. Pack contribution → Experimental (unless in surface.enabled).
 *   4. Explicit catalog `tier` override → that value (cannot demote Core).
 *   5. Catalog overlay `hidden` verdict → Experimental.
 *   6. Otherwise → Extended.
 *
 * After derivation, the user's `surface.enabled` / `surface.hidden`
 * config can flip a single dimension:
 *
 *   - `surface.enabled` contains the command → promote Experimental
 *     to Extended (callable, visible in `surface list` only — `--help`
 *     visibility is governed by the catalog's own defaultShowInHelp).
 *   - `surface.hidden` contains the command AND tier is Extended →
 *     remains Extended-tier but hidden from `--help`. The visibility
 *     flip is read by the help renderer, not by the tier resolver
 *     directly.
 *
 * Core commands cannot be hidden or disabled. Attempts to do so are
 * surfaced as warnings by `shrk doctor` and `shrk surface list --json`.
 */
export function resolveTier(
  entry: ICommandCatalogEntry,
  context: ITierResolverContext,
): ITierResolution {
  const name = entry.command;

  // 1. Bootstrap set always wins.
  if (BOOTSTRAP_COMMANDS.includes(name)) {
    return {
      tier: CommandTier.Core,
      source: TierSource.Bootstrap,
      detail: 'bootstrap command (always on)',
    };
  }

  // 2. Spine pipeline reference — also Core.
  if (context.spineCommands.has(name)) {
    return {
      tier: CommandTier.Core,
      source: TierSource.Spine,
      detail: 'referenced from a spine pipeline',
    };
  }

  // 3. Pack contributions default to Experimental, unless explicitly enabled.
  const pack = context.packContributions.get(name);
  if (pack !== undefined) {
    const enabled = (context.surfaceConfig?.enabled ?? []).includes(name);
    return {
      tier: enabled ? CommandTier.Extended : CommandTier.Experimental,
      source: TierSource.PackContribution,
      detail: enabled
        ? `pack-contributed (${pack}), enabled in surface.enabled`
        : `pack-contributed (${pack})`,
      configApplied: enabled,
    };
  }

  // 4. Explicit override on the catalog entry.
  if (entry.tier !== undefined) {
    // Cannot demote Core. The override applies for Extended/Experimental only.
    if (entry.tier === CommandTier.Experimental) {
      const enabled = (context.surfaceConfig?.enabled ?? []).includes(name);
      return {
        tier: enabled ? CommandTier.Extended : CommandTier.Experimental,
        source: TierSource.Override,
        detail: 'catalog override (tier=experimental)',
        configApplied: enabled,
      };
    }
    return {
      tier: entry.tier,
      source: TierSource.Override,
      detail: `catalog override (tier=${entry.tier})`,
    };
  }

  // 5. Catalog overlay `hidden` verdict implies Experimental.
  // We can't import the overlay here without a circular dep risk; the
  // caller passes a precomputed view via context. For now, we rely on
  // the catalog's surface=Internal/Legacy combined with showInDefaultHelp.
  // If the entry is marked showInDefaultHelp: false explicitly, that's a
  // weaker signal than the overlay but still pushes toward Experimental.
  if (entry.showInDefaultHelp === false) {
    const enabled = (context.surfaceConfig?.enabled ?? []).includes(name);
    return {
      tier: enabled ? CommandTier.Extended : CommandTier.Experimental,
      source: TierSource.Hidden,
      detail: 'showInDefaultHelp=false in catalog',
      configApplied: enabled,
    };
  }

  // 6. Default — Extended.
  return {
    tier: CommandTier.Extended,
    source: TierSource.Default,
    detail: 'default for catalog entries not in spine and not pack-contributed',
  };
}

/**
 * Is the command callable from the CLI / MCP in the current
 * surface configuration?
 *
 *   - Core: always callable.
 *   - Extended: always callable.
 *   - Experimental: callable only if in `surface.enabled`.
 *
 * The resolver's promotion of Experimental → Extended already accounts
 * for `enabled[]`, so this is a simple tier check.
 */
export function isCallable(resolution: ITierResolution): boolean {
  return (
    resolution.tier === CommandTier.Core ||
    resolution.tier === CommandTier.Extended
  );
}

/**
 * Should the command be visible in `--help` output?
 *
 *   - Core: always visible.
 *   - Extended: visible unless in `surface.hidden` (the help renderer
 *     checks the config and consults `defaultShowInHelp(entry)`).
 *   - Experimental: never visible in `--help`; only in `surface list`.
 *
 * The caller still consults `defaultShowInHelp(entry)` for the
 * underlying surface/lifecycle gating; this function answers "does
 * the tier permit visibility at all?".
 */
export function isVisibleInDefaultHelp(
  resolution: ITierResolution,
  hiddenByConfig: boolean,
): boolean {
  if (resolution.tier === CommandTier.Core) return true;
  if (resolution.tier === CommandTier.Experimental) return false;
  // Extended: respects hidden[].
  return !hiddenByConfig;
}
