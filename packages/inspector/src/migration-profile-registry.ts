/**
 * Migration profile registry. Loads pack-contributed migration profiles
 * via `migrationProfileFiles` on pack manifests. Engine ships zero built-ins.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import { type IMigrationProfile } from './migration-readiness.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const MIGRATION_PROFILE_REGISTRY_SCHEMA = 'sharkcraft.migration-profile-registry/v1';

export enum MigrationProfileSource {
  Local = 'local',
  Pack = 'pack',
}

export interface IMigrationProfileEntry {
  readonly profile: IMigrationProfile;
  readonly source: MigrationProfileSource;
  readonly packageName?: string;
  readonly sourceFile: string;
}

export interface IMigrationProfileRegistryIssue {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly profileId?: string;
  readonly source?: string;
}

async function importDefault<T>(file: string): Promise<readonly T[]> {
  const mod = (await import(pathToFileURL(file).href)) as {
    default?: readonly T[] | T;
    migrationProfiles?: readonly T[];
  };
  if (Array.isArray(mod.default)) return mod.default;
  if (mod.default && typeof mod.default === 'object') return [mod.default as T];
  if (Array.isArray(mod.migrationProfiles)) return mod.migrationProfiles;
  return [];
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['migration-profiles.ts', 'migration-profiles/index.ts']) {
    const full = nodePath.join(dir, name);
    if (existsSync(full)) out.push(full);
  }
  const cfg = inspection.config as { migrationProfileFiles?: readonly string[] } | null;
  for (const rel of cfg?.migrationProfileFiles ?? []) {
    out.push(nodePath.isAbsolute(rel) ? rel : nodePath.join(dir, rel));
  }
  return out;
}

function looksValid(raw: unknown): raw is IMigrationProfile {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.title === 'string' && Array.isArray(o.checks);
}

export async function loadMigrationProfiles(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IMigrationProfileEntry[];
  issues: readonly IMigrationProfileRegistryIssue[];
}> {
  const entries: IMigrationProfileEntry[] = [];
  const issues: IMigrationProfileRegistryIssue[] = [];
  const seen = new Set<string>();

  const ingest = (
    raw: unknown,
    source: MigrationProfileSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    if (!looksValid(raw)) {
      issues.push({
        severity: 'warning',
        code: 'invalid-profile',
        message: `Invalid migration profile at ${sourceFile}; skipped.`,
        source: sourceFile,
      });
      return;
    }
    if (seen.has(raw.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Migration profile id "${raw.id}" already loaded; skipping ${sourceFile}.`,
        profileId: raw.id,
        source: sourceFile,
      });
      return;
    }
    seen.add(raw.id);
    entries.push({
      profile: raw,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    });
  };

  for (const file of localFiles(inspection)) {
    try {
      const list = await importDefault<unknown>(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      for (const raw of list) ingest(raw, MigrationProfileSource.Local, undefined, rel);
    } catch (e) {
      issues.push({
        severity: 'warning',
        code: 'load-failed',
        message: `Failed to load ${file}: ${(e as Error).message}`,
        source: file,
      });
    }
  }
  for (const pack of inspection.packs.validPacks ?? []) {
    const contributions = (pack.manifest?.contributions ?? {}) as {
      migrationProfileFiles?: readonly string[];
    };
    for (const rel of contributions.migrationProfileFiles ?? []) {
      const file = nodePath.resolve(pack.packageRoot, rel);
      if (!existsSync(file)) {
        issues.push({
          severity: 'warning',
          code: 'missing-file',
          message: `Pack ${pack.packageName} declares migration profile ${rel} but file is missing.`,
          source: file,
        });
        continue;
      }
      try {
        const list = await importDefault<unknown>(file);
        for (const raw of list) ingest(raw, MigrationProfileSource.Pack, pack.packageName, rel);
      } catch (e) {
        issues.push({
          severity: 'warning',
          code: 'load-failed',
          message: `Pack ${pack.packageName} (${rel}): ${(e as Error).message}`,
          source: file,
        });
      }
    }
  }
  return { entries, issues };
}

export async function listMigrationProfilesFromPacks(
  inspection: ISharkcraftInspection,
): Promise<readonly IMigrationProfile[]> {
  const { entries } = await loadMigrationProfiles(inspection);
  return entries.map((e) => e.profile);
}
