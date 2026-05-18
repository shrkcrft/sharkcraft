import { inspectSharkcraft, type ISharkcraftInspection } from '@shrkcrft/inspector';
import type { ISurfaceConfig } from '@shrkcrft/config';
import { extractSpineCommands } from './spine-extractor.ts';
import { BUILTIN_PROFILES, getProfile, type ISurfaceProfile } from './profiles.ts';
import type { ITierResolverContext } from './tier.ts';

export interface LoadSurfaceContextOptions {
  cwd: string;
  /** Optional pre-loaded inspection to avoid the double-load cost. */
  inspection?: ISharkcraftInspection;
}

export interface ILoadedSurfaceContext {
  context: ITierResolverContext;
  inspection: ISharkcraftInspection;
  /**
   * Profiles in effect for this resolution: built-in
   * profiles known to the resolver + any pack-contributed profiles.
   * Sorted: builtin first, then pack contributions.
   */
  availableProfiles: readonly ISurfaceProfile[];
  /** The resolved profile (after config.surface.profile lookup), if any. */
  activeProfile?: ISurfaceProfile;
}

/**
 * Build the {@link ITierResolverContext} from a workspace.
 *
 * Steps:
 *   1. Load (or reuse) the inspector for `cwd`.
 *   2. Extract spine commands from the pipeline registry.
 *   3. Collect pack-contributed commands (currently empty in the
 *      engine repo — `ICommandPlugin` exists in the plugin-api but no
 *      pack contributes commands today; future packs will populate
 *      the inspection's pack discovery).
 *   4. Read the user's `surface{}` config block.
 */
export async function loadSurfaceContext(
  options: LoadSurfaceContextOptions,
): Promise<ILoadedSurfaceContext> {
  const inspection =
    options.inspection ?? (await inspectSharkcraft({ cwd: options.cwd }));

  const spineCommands = extractSpineCommands(inspection.pipelines);
  const packContributions = collectPackContributions(inspection);
  const packProfiles = collectPackProfiles(inspection);
  const rawConfig: ISurfaceConfig | undefined =
    inspection.config?.surface ?? undefined;

  // Resolve profile (built-in or pack-contributed).
  const profileId = rawConfig?.profile;
  const activeProfile = profileId
    ? getProfile(profileId, packProfiles)
    : undefined;

  // Compose profile.hidden + config.hidden / profile.enabled + config.enabled.
  // Config wins on conflicts (explicit user choice over profile default).
  const mergedHidden = mergeUnique(activeProfile?.hidden, rawConfig?.hidden);
  const mergedEnabled = mergeUnique(activeProfile?.enabled, rawConfig?.enabled);
  const surfaceConfig: ISurfaceConfig | undefined =
    rawConfig || activeProfile
      ? {
          ...(profileId ? { profile: profileId } : {}),
          ...(mergedHidden.length > 0 ? { hidden: mergedHidden } : {}),
          ...(mergedEnabled.length > 0 ? { enabled: mergedEnabled } : {}),
        }
      : undefined;

  return {
    inspection,
    context: { spineCommands, packContributions, surfaceConfig },
    availableProfiles: [...BUILTIN_PROFILES, ...packProfiles],
    ...(activeProfile ? { activeProfile } : {}),
  };
}

function mergeUnique(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): string[] {
  const set = new Set<string>([...(a ?? []), ...(b ?? [])]);
  return [...set].sort();
}

/**
 * Collect pack-contributed surface profiles. Pack
 * manifests can declare `contributions.surfaceProfiles[]`. Today this
 * is a new manifest slot — older packs return zero.
 */
function collectPackProfiles(
  inspection: ISharkcraftInspection,
): ISurfaceProfile[] {
  const out: ISurfaceProfile[] = [];
  const packs = inspection.packs?.discoveredPacks ?? [];
  for (const pack of packs) {
    const contributions = (pack.manifest?.contributions ?? {}) as Record<string, unknown>;
    const raw = (contributions.surfaceProfiles as readonly Record<string, unknown>[]) ?? [];
    for (const r of raw) {
      if (typeof r?.id !== 'string' || r.id.length === 0) continue;
      out.push({
        id: r.id,
        description: typeof r.description === 'string' ? r.description : `Pack profile (${pack.packageName})`,
        source: 'pack',
        pack: pack.packageName,
        ...(Array.isArray(r.hidden) ? { hidden: (r.hidden as string[]).filter((s) => typeof s === 'string') } : {}),
        ...(Array.isArray(r.enabled) ? { enabled: (r.enabled as string[]).filter((s) => typeof s === 'string') } : {}),
      });
    }
  }
  return out;
}

/**
 * Collect pack-contributed CLI command names. Today the pack
 * manifest schema has no `commandFiles[]` contribution slot, so this
 * always returns an empty map in the current engine repo. The
 * future-proofing is intentional: when packs gain command-contribution
 * support, the tier resolver immediately starts marking them
 * `experimental` by default.
 *
 * The lookup walks `IDiscoveredPack.manifest.contributions.commands[]`
 * defensively — the field doesn't exist in the v1 manifest schema, but
 * a future schema bump can add it without changing this code.
 */
function collectPackContributions(
  inspection: ISharkcraftInspection,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const packs = inspection.packs?.discoveredPacks ?? [];
  for (const pack of packs) {
    const contributions = (pack.manifest?.contributions ?? {}) as Record<string, unknown>;
    const commands = (contributions.commands as readonly { name?: string }[]) ?? [];
    for (const cmd of commands) {
      if (typeof cmd?.name === 'string' && cmd.name.length > 0) {
        map.set(cmd.name, pack.packageName);
      }
    }
  }
  return map;
}
