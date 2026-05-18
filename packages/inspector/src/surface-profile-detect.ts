/**
 * Map detected workspace profiles to a surface profile id.
 *
 * The built-in surface profiles ship with the engine:
 *   - `developer`   — the default; full set of common verbs.
 *   - `small-app`   — single-package TS/JS app.
 *   - `monorepo`    — nx / turborepo / pnpm workspaces.
 *   - `pack-author` — repos that publish a SharkCraft pack.
 *   - `ci`          — CI-only invocations (read-only, JSON-first).
 *   - `agent`       — agent-driven sessions (compact catalog).
 *
 * Workspace profiles come from `@shrkcrft/workspace` (e.g. `nx`,
 * `pnpm`, `next`, `nest`, `bun`, `single-package`, …). This module
 * maps them into a surface profile + the heuristic that fired, so the
 * generated `sharkcraft.config.ts` can record *why* the picked profile
 * was chosen.
 */

export enum SurfaceProfile {
  Developer = 'developer',
  SmallApp = 'small-app',
  Monorepo = 'monorepo',
  PackAuthor = 'pack-author',
  Ci = 'ci',
  Agent = 'agent',
}

export interface ISurfaceProfileSuggestion {
  profile: SurfaceProfile;
  /** One-line description of why this profile was picked. */
  reason: string;
}

/**
 * Pure function — no IO. Maps a list of workspace profiles
 * (`['nx', 'typescript']`, `['single-package', 'next']`, …) to one of
 * the built-in surface profiles plus the heuristic that fired.
 */
export function suggestSurfaceProfile(
  workspaceProfiles: readonly string[],
): ISurfaceProfileSuggestion {
  const set = new Set(workspaceProfiles.map((p) => p.toLowerCase()));
  if (set.has('pack-author') || set.has('sharkcraft-pack')) {
    return {
      profile: SurfaceProfile.PackAuthor,
      reason: 'workspace looks like a SharkCraft pack (manifest detected).',
    };
  }
  if (set.has('nx') || set.has('turborepo') || set.has('pnpm-workspace') || set.has('monorepo')) {
    return {
      profile: SurfaceProfile.Monorepo,
      reason:
        'monorepo signal detected (nx.json / turbo.json / pnpm-workspace.yaml / packages glob).',
    };
  }
  if (set.has('single-package') || set.has('app') || set.has('next') || set.has('nest')) {
    return {
      profile: SurfaceProfile.SmallApp,
      reason: 'single-package application shape detected.',
    };
  }
  if (set.has('ci-only') || set.has('headless')) {
    return {
      profile: SurfaceProfile.Ci,
      reason: 'CI-only signal (no interactive shells / no editor configs).',
    };
  }
  return {
    profile: SurfaceProfile.Developer,
    reason: 'no high-signal profile match — fell back to the default developer profile.',
  };
}

/**
 * Names every built-in surface profile so callers (doctor, init) can
 * validate user overrides without hardcoding the list at every site.
 */
export function listBuiltInSurfaceProfiles(): readonly SurfaceProfile[] {
  return [
    SurfaceProfile.Developer,
    SurfaceProfile.SmallApp,
    SurfaceProfile.Monorepo,
    SurfaceProfile.PackAuthor,
    SurfaceProfile.Ci,
    SurfaceProfile.Agent,
  ];
}
