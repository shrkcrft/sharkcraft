import type { ISurfaceConfig } from '@shrkcrft/config';
import {
  CommandTier,
  isToolMaintenance,
  type ICommandCatalogEntry,
} from '../commands/command-catalog.ts';
import type { ISurfaceDenial } from './i-surface-denial.ts';
import { SurfaceLayer } from './surface-layer.ts';
import { firstMatchingSelector } from './surface-selector.ts';

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
 * The detail of a tool-maintenance command resolved outside SharkCraft's own
 * repository (round 11 §5.1).
 */
export const TOOL_MAINTENANCE_DETAIL = 'maintains SharkCraft itself; does not apply to this repository';

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
  /**
   * A registered, dispatchable command with no catalog row. Extended (it runs),
   * flagged so `commands doctor` / `surface list` point at the missing row.
   */
  Uncatalogued = 'uncatalogued',
  /**
   * A command that maintains SharkCraft itself (catalog audience
   * `tool-maintenance`), resolved OUTSIDE SharkCraft's own repository:
   * experimental (gated, hidden from `--help`) unless `surface.enabled` names
   * it. Invoking it exits 78 through the surface gate — never a check failure.
   */
  ToolMaintenance = 'tool-maintenance',
  /** Denied by a `surface.disabled` selector (project config or profile). */
  Disabled = 'disabled',
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
  /** The `surface.disabled` selector (and its layer) that denies the command — source `disabled` only. */
  deniedBy?: ISurfaceDenial;
}

export interface ITierResolverContext {
  /** Catalog command names ({@link ICommandCatalogEntry.command}) referenced by spine pipelines. */
  spineCommands: ReadonlySet<string>;
  /** Catalog command names contributed by loaded packs (pack-contributed commands). */
  packContributions: ReadonlyMap<string, string>; // command → pack name
  /**
   * The EFFECTIVE `surface{}` block: the active profile's lists merged with the
   * project config's (may be undefined for a fresh repo).
   */
  surfaceConfig: ISurfaceConfig | undefined;
  /**
   * True only inside SharkCraft's OWN repository — `detectSharkcraftRepo`, the
   * one host authority. Everywhere else a tool-maintenance command resolves
   * experimental with source {@link TierSource.ToolMaintenance}.
   */
  isToolRepo: boolean;
  /**
   * The project config's OWN `surface.enabled` / `surface.disabled`, before the
   * profile merge. The resolver needs the layer for exactly one rule: an
   * explicit config `enabled` overrides a PROFILE's deny, never a config deny.
   * Absent = `surfaceConfig` IS the project config (no profile layer).
   */
  explicitSurface?: Pick<ISurfaceConfig, 'enabled' | 'disabled'>;
}

/**
 * Mechanically derive a command's tier.
 *
 * Resolution order (HIGHEST wins, never demotes Core):
 *
 *   1. Bootstrap set → Core.
 *   2. Spine pipeline reference → Core.
 *   3. A `surface.disabled` selector → Experimental, source `disabled`
 *      (never a bootstrap command or one of its subverbs; an explicit config
 *      `enabled` overrides a PROFILE's deny, never a config deny).
 *   4. A tool-maintenance command outside SharkCraft's own repository →
 *      Experimental, source `tool-maintenance` (unless in surface.enabled).
 *   5. Pack contribution → Experimental (unless in surface.enabled).
 *   6. Explicit catalog `tier` override → that value (cannot demote Core).
 *   7. Catalog overlay `hidden` verdict → Experimental.
 *   8. Otherwise → Extended.
 *
 * Every `enabled` / `hidden` / `disabled` entry is a selector — an exact path
 * (or alias spelling) or `<group> *` — matched by the ONE matcher
 * (`surface-selector.ts`).
 *
 * After derivation, `surface.hidden` flips `--help` visibility of an Extended
 * command (read by the summary); it never changes callability.
 *
 * Core commands cannot be hidden or disabled. Attempts to do so are
 * surfaced as warnings by `shrk doctor` and `shrk surface list --json`.
 */
export function resolveTier(
  entry: ICommandCatalogEntry,
  context: ITierResolverContext,
): ITierResolution {
  return deriveTier(entry.command, entry, context, []);
}

/**
 * Tier of a command-index path. `entry` is the path's base catalog row, or
 * `undefined` for a registered command the catalog does not document — which
 * still gets the bootstrap / spine / deny / pack derivation, and otherwise
 * resolves Extended with {@link TierSource.Uncatalogued}. `aliases` are the
 * path's alias spellings: a selector naming an alias names the command.
 */
export function resolveTierForPath(
  path: string,
  entry: ICommandCatalogEntry | undefined,
  context: ITierResolverContext,
  aliases: readonly string[] = [],
): ITierResolution {
  return deriveTier(path, entry, context, aliases);
}

/**
 * A bootstrap command or one of its subverbs (`surface allow`, `doctor
 * suppress`). A deny selector never applies to one: `surface deny 'surface *'`
 * must not lock the user out of the verb that undoes it.
 */
export function isBootstrapFamily(name: string): boolean {
  return BOOTSTRAP_COMMANDS.some((b) => name === b || name.startsWith(`${b} `));
}

/**
 * THE deny decision: the `surface.disabled` selector that denies a command
 * named by any of `names` (its path plus alias spellings), with the layer that
 * declared it — or `undefined` when nothing denies it.
 *
 *   - a config deny always wins (even over a config `enabled` — the summary
 *     warns `enable-disable-conflict`);
 *   - a deny only the active PROFILE declares is overridden by an explicit
 *     config `enabled` match ("config wins over the profile").
 */
export function surfaceDenial(
  names: readonly string[],
  context: ITierResolverContext,
): ISurfaceDenial | undefined {
  const explicit = context.explicitSurface ?? context.surfaceConfig;
  const configSelector = firstMatchingSelector(explicit?.disabled, names);
  if (configSelector !== undefined) return { selector: configSelector, origin: SurfaceLayer.Config };
  const mergedSelector = firstMatchingSelector(context.surfaceConfig?.disabled, names);
  if (mergedSelector === undefined) return undefined;
  if (firstMatchingSelector(explicit?.enabled, names) !== undefined) return undefined;
  return { selector: mergedSelector, origin: SurfaceLayer.Profile };
}

function deriveTier(
  name: string,
  entry: ICommandCatalogEntry | undefined,
  context: ITierResolverContext,
  aliases: readonly string[],
): ITierResolution {
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

  const names = [name, ...aliases];

  // 3. A deny selector. Not callable, whatever the other derivations say.
  const deniedBy = isBootstrapFamily(name) ? undefined : surfaceDenial(names, context);
  if (deniedBy) {
    return {
      tier: CommandTier.Experimental,
      source: TierSource.Disabled,
      detail:
        deniedBy.origin === SurfaceLayer.Config
          ? `disabled by surface.disabled ('${deniedBy.selector}')`
          : `disabled by the ${profileLabel(context)} surface profile ('${deniedBy.selector}')`,
      configApplied: true,
      deniedBy,
    };
  }

  const enabled = firstMatchingSelector(context.surfaceConfig?.enabled, names) !== undefined;

  // 4. A command that maintains SharkCraft itself, outside SharkCraft's repo.
  if (entry && isToolMaintenance(entry) && !context.isToolRepo) {
    return {
      tier: enabled ? CommandTier.Extended : CommandTier.Experimental,
      source: TierSource.ToolMaintenance,
      detail: enabled ? `${TOOL_MAINTENANCE_DETAIL} — enabled in surface.enabled` : TOOL_MAINTENANCE_DETAIL,
      ...(enabled ? { configApplied: true } : {}),
    };
  }

  // 5. Pack contributions default to Experimental, unless explicitly enabled.
  const pack = context.packContributions.get(name);
  if (pack !== undefined) {
    return {
      tier: enabled ? CommandTier.Extended : CommandTier.Experimental,
      source: TierSource.PackContribution,
      detail: enabled
        ? `pack-contributed (${pack}), enabled in surface.enabled`
        : `pack-contributed (${pack})`,
      configApplied: enabled,
    };
  }

  // No catalog row: the derivations above are all that apply.
  if (!entry) {
    return {
      tier: CommandTier.Extended,
      source: TierSource.Uncatalogued,
      // `commands doctor` maintains SharkCraft itself (exit 78 elsewhere): only
      // inside the tool repository is it the remedy. Outside, the missing row
      // is SharkCraft's catalog gap — nothing this repository can fix.
      detail: context.isToolRepo
        ? 'registered but has no catalog row — run `shrk commands doctor`'
        : "registered but missing from SharkCraft's command catalog — a SharkCraft catalog gap, not a problem in this repository",
    };
  }

  // 6. Explicit override on the catalog entry.
  if (entry.tier !== undefined) {
    // Cannot demote Core. The override applies for Extended/Experimental only.
    if (entry.tier === CommandTier.Experimental) {
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

  // 7. Catalog overlay `hidden` verdict implies Experimental.
  // We can't import the overlay here without a circular dep risk; the
  // caller passes a precomputed view via context. For now, we rely on
  // the catalog's surface=Internal/Legacy combined with showInDefaultHelp.
  // If the entry is marked showInDefaultHelp: false explicitly, that's a
  // weaker signal than the overlay but still pushes toward Experimental.
  if (entry.showInDefaultHelp === false) {
    return {
      tier: enabled ? CommandTier.Extended : CommandTier.Experimental,
      source: TierSource.Hidden,
      detail: 'showInDefaultHelp=false in catalog',
      configApplied: enabled,
    };
  }

  // 8. Default — Extended. No `detail`: it was the same placeholder sentence on
  // every one of ~436 rows, so the listing could not say what anything does.
  // `surface explain` renders the source instead.
  return {
    tier: CommandTier.Extended,
    source: TierSource.Default,
  };
}

function profileLabel(context: ITierResolverContext): string {
  const id = context.surfaceConfig?.profile;
  return id ? `'${id}'` : 'active';
}

/**
 * Is the command callable from the CLI / MCP in the current
 * surface configuration?
 *
 *   - Core: always callable.
 *   - Extended: always callable.
 *   - Experimental: callable only if in `surface.enabled` (the resolver has
 *     already promoted an enabled command to Extended — and never promotes a
 *     denied one).
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
 * The caller still consults the catalog's help rule for the underlying
 * surface/lifecycle gating; this function answers "does the tier permit
 * visibility at all?".
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
