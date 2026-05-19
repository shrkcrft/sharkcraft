/**
 * Plugin lifecycle profile registry.
 *
 * Loads pack-contributed and locally configured `IPluginLifecycleProfile`
 * entries. Duplicate ids and invalid profiles surface as doctor issues.
 * Source attribution lets the CLI tell the user where a profile came from.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  validatePluginLifecycleProfile,
  type IPluginLifecycleProfile,
} from '@shrkcrft/plugin-api';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

export const PLUGIN_LIFECYCLE_PROFILE_REGISTRY_SCHEMA =
  'sharkcraft.plugin-lifecycle-profile-registry/v1';

export enum PluginLifecycleProfileSource {
  Local = 'local',
  Pack = 'pack',
  Fixture = 'fixture',
}

export interface IPluginLifecycleProfileEntry {
  readonly profile: IPluginLifecycleProfile;
  readonly source: PluginLifecycleProfileSource;
  readonly packageName?: string;
  readonly sourceFile: string;
}

export enum ProfileDoctorSeverity {
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

export interface IPluginLifecycleProfileDoctorIssue {
  readonly severity: ProfileDoctorSeverity;
  readonly code: string;
  readonly message: string;
  readonly profileId?: string;
  readonly source?: string;
}

interface ICacheEntry {
  cacheKey: string;
  entries: readonly IPluginLifecycleProfileEntry[];
  issues: readonly IPluginLifecycleProfileDoctorIssue[];
}

const CACHE = new Map<string, ICacheEntry>();

async function importDefaultProfiles(file: string): Promise<readonly IPluginLifecycleProfile[]> {
  const mod = (await importModuleViaLoader(file)) as {
    default?: readonly IPluginLifecycleProfile[] | IPluginLifecycleProfile;
    pluginLifecycleProfiles?: readonly IPluginLifecycleProfile[];
  };
  if (Array.isArray(mod.default)) return mod.default;
  if (mod.default && typeof mod.default === 'object') return [mod.default as IPluginLifecycleProfile];
  if (Array.isArray(mod.pluginLifecycleProfiles)) return mod.pluginLifecycleProfiles;
  return [];
}

function localProfileFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['plugin-lifecycle-profiles.ts', 'plugin-lifecycle-profiles/index.ts']) {
    const full = nodePath.join(dir, name);
    if (existsSync(full)) out.push(full);
  }
  const cfg = inspection.config as
    | { pluginLifecycleProfileFiles?: readonly string[] }
    | null;
  for (const rel of cfg?.pluginLifecycleProfileFiles ?? []) {
    out.push(nodePath.isAbsolute(rel) ? rel : nodePath.join(dir, rel));
  }
  return out;
}

export async function loadPluginLifecycleProfiles(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IPluginLifecycleProfileEntry[];
  issues: readonly IPluginLifecycleProfileDoctorIssue[];
}> {
  const cacheKey = `${inspection.projectRoot}:${(inspection.packs.validPacks ?? [])
    .map((p) => p.packageName + '@' + p.packageVersion)
    .join(',')}`;
  const cached = CACHE.get(inspection.projectRoot);
  if (cached && cached.cacheKey === cacheKey) {
    return { entries: cached.entries, issues: cached.issues };
  }
  const seen = new Map<string, IPluginLifecycleProfileEntry>();
  const entries: IPluginLifecycleProfileEntry[] = [];
  const issues: IPluginLifecycleProfileDoctorIssue[] = [];

  const ingest = (
    profile: IPluginLifecycleProfile,
    source: PluginLifecycleProfileSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    const validation = validatePluginLifecycleProfile(profile);
    if (!validation.valid) {
      for (const issue of validation.issues) {
        issues.push({
          severity: ProfileDoctorSeverity.Error,
          code: 'invalid-profile',
          message: `${issue.field}: ${issue.message}`,
          profileId: typeof profile.id === 'string' ? profile.id : undefined,
          source: sourceFile,
        });
      }
      return;
    }
    const existing = seen.get(profile.id);
    if (existing) {
      issues.push({
        severity: ProfileDoctorSeverity.Error,
        code: 'duplicate-id',
        message: `Profile id "${profile.id}" already loaded from ${existing.sourceFile} (source=${existing.source}); skipping duplicate from ${sourceFile} (source=${source}).`,
        profileId: profile.id,
        source: sourceFile,
      });
      return;
    }
    const entry: IPluginLifecycleProfileEntry = {
      profile,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    };
    seen.set(profile.id, entry);
    entries.push(entry);
  };

  for (const file of localProfileFiles(inspection)) {
    try {
      const list = await importDefaultProfiles(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      for (const raw of list) {
        ingest(raw, PluginLifecycleProfileSource.Local, undefined, rel);
      }
    } catch (e) {
      issues.push({
        severity: ProfileDoctorSeverity.Warning,
        code: 'load-failed',
        message: `Failed to load ${file}: ${(e as Error).message}`,
        source: file,
      });
    }
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as {
      pluginLifecycleProfileFiles?: readonly string[];
    };
    for (const rel of contributions.pluginLifecycleProfileFiles ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        issues.push({
          severity: ProfileDoctorSeverity.Warning,
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares profile file ${rel} but it is missing.`,
          source: file,
        });
        continue;
      }
      try {
        const list = await importDefaultProfiles(file);
        for (const raw of list) {
          ingest(raw, PluginLifecycleProfileSource.Pack, pack.packageName, rel);
        }
      } catch (e) {
        issues.push({
          severity: ProfileDoctorSeverity.Warning,
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${rel}): ${(e as Error).message}`,
          source: file,
        });
      }
    }
  }
  CACHE.set(inspection.projectRoot, { cacheKey, entries, issues });
  return { entries, issues };
}

export async function listPluginLifecycleProfiles(
  inspection: ISharkcraftInspection,
): Promise<readonly IPluginLifecycleProfileEntry[]> {
  const { entries } = await loadPluginLifecycleProfiles(inspection);
  return entries;
}

export async function findPluginLifecycleProfile(
  inspection: ISharkcraftInspection,
  id: string,
): Promise<IPluginLifecycleProfileEntry | null> {
  const entries = await listPluginLifecycleProfiles(inspection);
  return entries.find((e) => e.profile.id === id) ?? null;
}

export async function listPluginLifecycleProfileIssues(
  inspection: ISharkcraftInspection,
): Promise<readonly IPluginLifecycleProfileDoctorIssue[]> {
  const { issues } = await loadPluginLifecycleProfiles(inspection);
  return issues;
}

export function clearPluginLifecycleProfileCache(projectRoot?: string): void {
  if (projectRoot) CACHE.delete(projectRoot);
  else CACHE.clear();
}

export interface IResolveProfileOptions {
  /** Explicit profile id (e.g. from --profile). */
  readonly profileId?: string;
  /** If true and there is exactly one profile, return it implicitly. */
  readonly allowSingleDefault?: boolean;
}

export interface IResolveProfileResult {
  readonly entry?: IPluginLifecycleProfileEntry;
  readonly error?: string;
  readonly availableIds: readonly string[];
}

/**
 * Pick a profile from the registry. If `profileId` is supplied, look it up.
 * If not and exactly one profile is registered and `allowSingleDefault` is
 * true, return it. Otherwise emit an explanatory error string and list ids.
 */
export async function resolvePluginLifecycleProfile(
  inspection: ISharkcraftInspection,
  options: IResolveProfileOptions = {},
): Promise<IResolveProfileResult> {
  const entries = await listPluginLifecycleProfiles(inspection);
  const availableIds = entries.map((e) => e.profile.id);
  if (options.profileId) {
    const found = entries.find((e) => e.profile.id === options.profileId);
    if (found) return { entry: found, availableIds };
    return {
      error: `Unknown plugin lifecycle profile "${options.profileId}". Available: ${availableIds.length === 0 ? '(none registered)' : availableIds.join(', ')}. Contribute one via a pack manifest "pluginLifecycleProfileFiles" entry or sharkcraft/plugin-lifecycle-profiles.ts.`,
      availableIds,
    };
  }
  if (entries.length === 0) {
    return {
      error:
        'No plugin lifecycle profiles registered. Contribute one via a pack manifest "pluginLifecycleProfileFiles" entry or sharkcraft/plugin-lifecycle-profiles.ts.',
      availableIds,
    };
  }
  if (entries.length === 1 && options.allowSingleDefault) {
    return { entry: entries[0]!, availableIds };
  }
  return {
    error: `--profile required. Available: ${availableIds.join(', ')}.`,
    availableIds,
  };
}
