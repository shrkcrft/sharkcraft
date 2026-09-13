import { WorkspaceProfile } from './profile-detector.ts';

/**
 * Every {@link WorkspaceProfile} id the engine knows — the builtin vocabulary
 * an applicability filter (`IPreset.appliesTo`, a convention's
 * `appliesTo.profileIds`, a registration hint's `discovery.profileIds`, a
 * template's `metadata.requiredProfileIds`) may name. Detection is per repo
 * (`inspection.workspace.profiles`); the VOCABULARY is not, so an id is valid
 * whether or not this repo exhibits it.
 */
export function listWorkspaceProfiles(): readonly WorkspaceProfile[] {
  return Object.values(WorkspaceProfile);
}
