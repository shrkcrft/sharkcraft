/**
 * Migration profile registry. Loads pack-contributed migration profiles
 * via `migrationProfileFiles` on pack manifests. Engine ships zero built-ins.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { type IMigrationProfile } from './migration-readiness.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  importModuleViaLoader,
  readContributionExport,
  RejectionCause,
  type IContributionExport,
  type IRejectedEntry,
} from '@shrkcrft/core';

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

async function importProfiles(file: string): Promise<IContributionExport> {
  return readContributionExport(await importModuleViaLoader(file), { namedKeys: ['migrationProfiles'] });
}

function localFiles(inspection: ISharkcraftInspection): string[] {
  const out: string[] = [];
  const dir = inspection.sharkcraftDir;
  if (!dir) return [];
  for (const name of ['migration-profiles.ts', 'migration-profiles/index.ts']) {
    const full = nodePath.join(dir, name);
    if (existsSync(full)) out.push(full);
  }
  // More profile files come from pack manifests (`migrationProfileFiles`,
  // loaded below) — there is no local-config key for them; the strict config
  // schema rejects one, so a local read here could never be reached.
  return out;
}

/**
 * THE migration-profile acceptance predicate (round 12, 12.1): one
 * `<field>: <message>` per failing field — `[]` means accepted. A refused
 * profile used to read `Invalid migration profile at <file>; skipped.`
 * with no id and no field.
 */
export function migrationProfileRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const o = raw as Record<string, unknown>;
  const out: string[] = [];
  if (typeof o.id !== 'string') out.push('id: must be a string');
  if (typeof o.title !== 'string') out.push('title: must be a string');
  if (!Array.isArray(o.checks)) out.push('checks: must be an array');
  return out;
}

export async function loadMigrationProfiles(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IMigrationProfileEntry[];
  issues: readonly IMigrationProfileRegistryIssue[];
  /** Every declared profile the loader refused — invalid or a duplicate id (round 12, 12.1). */
  rejected: readonly IRejectedEntry[];
}> {
  const entries: IMigrationProfileEntry[] = [];
  const issues: IMigrationProfileRegistryIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  const seen = new Map<string, string>();

  const ingest = (
    raw: unknown,
    source: MigrationProfileSource,
    packageName: string | undefined,
    sourceFile: string,
    at: Pick<IRejectedEntry, 'file' | 'index' | 'exportName'>,
  ): void => {
    const rawId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    const id = typeof rawId === 'string' ? rawId : undefined;
    const reasons = migrationProfileRejectionReasons(raw);
    if (reasons.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'invalid-profile',
        message: `Invalid migration profile${id ? ` "${id}"` : ''} at ${sourceFile} (${at.exportName ?? 'default'}[${at.index}]); skipped — ${reasons.join('; ')}.`,
        ...(id ? { profileId: id } : {}),
        source: sourceFile,
      });
      rejected.push({ ...at, ...(id ? { entryId: id } : {}), reasons, cause: RejectionCause.Invalid });
      return;
    }
    const profile = raw as IMigrationProfile;
    const prev = seen.get(profile.id);
    if (prev !== undefined) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        message: `Migration profile id "${profile.id}" already loaded; skipping ${sourceFile}.`,
        profileId: profile.id,
        source: sourceFile,
      });
      rejected.push({
        ...at,
        entryId: profile.id,
        reasons: [`id: "${profile.id}" is already declared in ${prev}`],
        cause: RejectionCause.DuplicateId,
      });
      return;
    }
    seen.set(profile.id, sourceFile);
    entries.push({
      profile,
      source,
      ...(packageName ? { packageName } : {}),
      sourceFile,
    });
  };
  const ingestAll = (
    exp: IContributionExport,
    file: string,
    source: MigrationProfileSource,
    packageName: string | undefined,
    sourceFile: string,
  ): void => {
    exp.items.forEach((raw, i) =>
      ingest(raw, source, packageName, sourceFile, {
        file,
        index: exp.single ? -1 : i,
        ...(exp.exportName ? { exportName: exp.exportName } : {}),
      }),
    );
  };

  for (const file of localFiles(inspection)) {
    try {
      const exp = await importProfiles(file);
      const rel = nodePath.relative(inspection.projectRoot, file) || file;
      ingestAll(exp, file, MigrationProfileSource.Local, undefined, rel);
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
        ingestAll(await importProfiles(file), file, MigrationProfileSource.Pack, pack.packageName, rel);
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
  return { entries, issues, rejected };
}

export async function listMigrationProfilesFromPacks(
  inspection: ISharkcraftInspection,
): Promise<readonly IMigrationProfile[]> {
  const { entries } = await loadMigrationProfiles(inspection);
  return entries.map((e) => e.profile);
}
