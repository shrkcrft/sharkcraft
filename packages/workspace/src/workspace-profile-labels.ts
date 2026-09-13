import { WorkspaceProfile } from './profile-detector.ts';

/**
 * THE natural-language label of each {@link WorkspaceProfile} — one short
 * clause per profile (`uses TypeScript`, `is a monorepo`).
 *
 * `shrk presets explain` ("Applies when this repo: …") and the builtin
 * `workspace` profile kind (`shrk profiles list --kind workspace`) both read
 * this table, so a profile cannot be described one way in one surface and
 * another way in the next. It used to be a private map in the presets
 * command. Keyed by the enum: a profile added without a label is a compile
 * error, never a verbatim id in the output.
 */
const WORKSPACE_PROFILE_LABELS: Readonly<Record<WorkspaceProfile, string>> = Object.freeze({
  [WorkspaceProfile.HasBun]: 'uses Bun',
  [WorkspaceProfile.HasTypeScript]: 'uses TypeScript',
  [WorkspaceProfile.HasNx]: 'is an Nx workspace',
  [WorkspaceProfile.HasTurborepo]: 'is a Turborepo workspace',
  [WorkspaceProfile.HasReact]: 'uses React',
  [WorkspaceProfile.HasNext]: 'uses Next.js',
  [WorkspaceProfile.HasAngular]: 'uses Angular',
  [WorkspaceProfile.HasVue]: 'uses Vue',
  [WorkspaceProfile.HasNestJS]: 'uses NestJS',
  [WorkspaceProfile.HasMcpSdk]: 'depends on the MCP SDK',
  [WorkspaceProfile.HasTests]: 'has a test runner',
  [WorkspaceProfile.HasEslint]: 'uses ESLint',
  [WorkspaceProfile.HasBiome]: 'uses Biome',
  [WorkspaceProfile.HasVitest]: 'uses Vitest',
  [WorkspaceProfile.HasJest]: 'uses Jest',
  [WorkspaceProfile.HasBunTest]: 'uses bun test',
  [WorkspaceProfile.HasGithubActions]: 'has GitHub Actions',
  [WorkspaceProfile.HasPackageWorkspaces]: 'uses package workspaces (npm/pnpm/yarn)',
  [WorkspaceProfile.IsLibrary]: 'is published as a library',
  [WorkspaceProfile.IsService]: 'runs as a service',
  [WorkspaceProfile.IsMonorepo]: 'is a monorepo',
  [WorkspaceProfile.IsFrontend]: 'is a frontend',
  [WorkspaceProfile.IsBackend]: 'is a backend',
});

/**
 * The label of `profile`, or the id verbatim when it is not a
 * {@link WorkspaceProfile} (a preset may name a profile a newer engine
 * detects; it must still render).
 */
export function describeWorkspaceProfile(profile: string): string {
  return (WORKSPACE_PROFILE_LABELS as Readonly<Record<string, string>>)[profile] ?? profile;
}
