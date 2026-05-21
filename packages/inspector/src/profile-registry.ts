/**
 * Generic profile registry.
 *
 * Unifies profile-shaped contributions (migration profiles, future
 * profile kinds) under a single `shrk profiles ...` surface. The engine
 * ships zero built-in profiles; everything comes from pack contributions
 * or local config.
 *
 * Read-only.
 */
import { loadMigrationProfiles } from './migration-profile-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const PROFILE_REGISTRY_SCHEMA = 'sharkcraft.profile-registry/v1';

export enum ProfileKind {
  Migration = 'migration',
  /** Future: command-behavior, generator, boundary, naming, architecture, language, report. */
}

export enum ProfileSource {
  Builtin = 'builtin',
  Local = 'local',
  Pack = 'pack',
  Fixture = 'fixture',
}

export interface IProfileEntry {
  readonly id: string;
  readonly kind: ProfileKind;
  readonly title: string;
  readonly description?: string;
  readonly source: ProfileSource;
  readonly packageName?: string;
  readonly sourceFile?: string;
  readonly tags?: readonly string[];
  readonly appliesWhen?: readonly string[];
  /** The full profile payload (shape depends on `kind`). */
  readonly payload: unknown;
}

export interface IProfileRegistryIssue {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly profileId?: string;
  readonly kind?: ProfileKind;
}

export async function loadAllProfiles(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IProfileEntry[];
  issues: readonly IProfileRegistryIssue[];
}> {
  const entries: IProfileEntry[] = [];
  const issues: IProfileRegistryIssue[] = [];

  // Migration profiles
  try {
    const migration = await loadMigrationProfiles(inspection);
    for (const e of migration.entries) {
      entries.push({
        id: e.profile.id,
        kind: ProfileKind.Migration,
        title: e.profile.title,
        ...(e.profile.description ? { description: e.profile.description } : {}),
        source: e.source as unknown as ProfileSource,
        ...(e.packageName ? { packageName: e.packageName } : {}),
        sourceFile: e.sourceFile,
        payload: e.profile,
      });
    }
    for (const i of migration.issues) {
      issues.push({
        severity: i.severity,
        code: `migration:${i.code}`,
        message: i.message,
        ...(i.profileId ? { profileId: i.profileId } : {}),
        kind: ProfileKind.Migration,
      });
    }
  } catch (err) {
    issues.push({
      severity: 'warning',
      code: 'migration-load-failed',
      message: `Migration profile load failed: ${(err as Error).message}`,
      kind: ProfileKind.Migration,
    });
  }

  return { entries, issues };
}

export async function listProfiles(
  inspection: ISharkcraftInspection,
  options: { kind?: ProfileKind } = {},
): Promise<readonly IProfileEntry[]> {
  const { entries } = await loadAllProfiles(inspection);
  if (!options.kind) return entries;
  return entries.filter((e) => e.kind === options.kind);
}

export async function findProfile(
  inspection: ISharkcraftInspection,
  id: string,
  kind?: ProfileKind,
): Promise<IProfileEntry | null> {
  const { entries } = await loadAllProfiles(inspection);
  return (
    entries.find((e) => e.id === id && (!kind || e.kind === kind)) ?? null
  );
}

export async function listProfileIssues(
  inspection: ISharkcraftInspection,
): Promise<readonly IProfileRegistryIssue[]> {
  const { issues } = await loadAllProfiles(inspection);
  return issues;
}
