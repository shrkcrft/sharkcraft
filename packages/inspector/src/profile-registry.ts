/**
 * Generic profile registry.
 *
 * Unifies profile-shaped vocabularies under a single `shrk profiles ...`
 * surface (and MCP `list_profiles` / `get_profile`):
 *
 *   - `workspace` — BUILTIN: the engine's {@link WorkspaceProfile} vocabulary
 *     (`has-typescript`, `is-library`, …). The applicability filters
 *     (`IPreset.appliesTo`, a convention's `appliesTo.profileIds`, a
 *     registration hint's `discovery.profileIds`, a template's
 *     `metadata.requiredProfileIds`) name these ids, and THE id resolver's
 *     `workspace-profile` kind reads {@link listWorkspaceProfileEntries} — the
 *     same function `profiles list --kind workspace` prints. Every id is listed;
 *     `detected` says whether this repo exhibits it.
 *   - `migration` — pack-contributed (`migrationProfileFiles`) or local
 *     (`sharkcraft/migration-profiles.ts`) migration-readiness gates.
 *
 * Read-only.
 */
import { describeWorkspaceProfile, listWorkspaceProfiles } from '@shrkcrft/workspace';
import type { IWorkspaceProfilePayload } from './i-workspace-profile-payload.ts';
import { loadMigrationProfiles } from './migration-profile-registry.ts';
import type { IdReferenceKind } from './reference-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const PROFILE_REGISTRY_SCHEMA = 'sharkcraft.profile-registry/v1';

export enum ProfileKind {
  Migration = 'migration',
  /** Builtin: the engine's WorkspaceProfile vocabulary, with per-repo detection. */
  Workspace = 'workspace',
}

/**
 * The reference kind each profile kind's ids resolve as — so the declaration
 * table (`REFERENCE_KIND_DECLARATIONS`) can say how a profile kind is filled,
 * and a new {@link ProfileKind} without a resolver kind is a compile error.
 */
export const PROFILE_KIND_REFERENCE_KIND: Readonly<Record<ProfileKind, IdReferenceKind>> = Object.freeze({
  [ProfileKind.Migration]: 'migration-profile',
  [ProfileKind.Workspace]: 'workspace-profile',
});

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
  /**
   * `workspace` entries only: whether THIS repo exhibits the profile (the
   * same fact as `payload.detected`). Absent on other kinds.
   */
  readonly detected?: boolean;
  /** The full profile payload (shape depends on `kind`; `IWorkspaceProfilePayload` for `workspace`). */
  readonly payload: unknown;
}

export interface IProfileRegistryIssue {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly profileId?: string;
  readonly kind?: ProfileKind;
}

/**
 * THE builtin `workspace` profile entries: one per {@link WorkspaceProfile}
 * id, labelled by THE label table, `detected` from this inspection's workspace
 * detection. Synchronous and never empty — the resolver's `workspace-profile`
 * kind reads it, so it can never loud-skip.
 */
export function listWorkspaceProfileEntries(inspection: ISharkcraftInspection): readonly IProfileEntry[] {
  const evidence = new Map<string, string>();
  for (const e of inspection.workspace?.profileEvidence ?? []) evidence.set(e.profile, e.reason);
  const detected = new Set<string>(inspection.workspace?.profiles ?? []);
  return listWorkspaceProfiles().map((id): IProfileEntry => {
    const isDetected = detected.has(id);
    const reason = evidence.get(id);
    const payload: IWorkspaceProfilePayload = {
      detected: isDetected,
      ...(isDetected && reason !== undefined ? { reason } : {}),
    };
    return {
      id,
      kind: ProfileKind.Workspace,
      title: describeWorkspaceProfile(id),
      source: ProfileSource.Builtin,
      detected: isDetected,
      payload,
    };
  });
}

export async function loadAllProfiles(
  inspection: ISharkcraftInspection,
): Promise<{
  entries: readonly IProfileEntry[];
  issues: readonly IProfileRegistryIssue[];
}> {
  // Builtin first: the vocabulary every applicability filter names.
  const entries: IProfileEntry[] = [...listWorkspaceProfileEntries(inspection)];
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

/** True when `value` names a {@link ProfileKind} — THE parse the CLI `--kind` flag and MCP `kind` input share. */
export function isProfileKind(value: string): value is ProfileKind {
  return (Object.values(ProfileKind) as readonly string[]).includes(value);
}
