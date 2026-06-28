/**
 * Surface profiles.
 *
 * A profile is a named set of `surface.hidden` + `surface.enabled`
 * adjustments. Built-in profiles ship from the engine; packs can
 * contribute additional profiles via the pack manifest (see
 * load-surface-context.ts). The user selects one via
 * `sharkcraft.config.ts surface.profile`.
 *
 * Profiles are PURE DATA — no logic, no AI. Adding a profile is just
 * adding an entry here (or in a pack manifest).
 */

import { COMMAND_CATALOG } from '../commands/command-catalog.ts';

export interface ISurfaceProfile {
  /** Stable id used by `surface.profile` config + CLI selection. */
  id: string;
  /** One-line description shown in `surface profiles list`. */
  description: string;
  /** Extended commands this profile hides from `--help`. */
  hidden?: readonly string[];
  /**
   * Experimental commands this profile enables. Use sparingly —
   * profiles should compose with packs' default `experimental`
   * classification, not paper over it.
   */
  enabled?: readonly string[];
  /** Where the profile comes from (annotation for `surface explain`). */
  source: 'builtin' | 'pack' | 'local';
  /** When source='pack', the pack name. */
  pack?: string;
}

/**
 * `developer` profile. Default for monorepo / app-with-libs shapes.
 * Hides nothing — pack authors / power users see the full extended
 * surface.
 */
const DEVELOPER_PROFILE: ISurfaceProfile = {
  id: 'developer',
  description:
    'Full visible surface for power users / pack authors / engine contributors. Hides nothing.',
  source: 'builtin',
};

/**
 * `small-app` profile. Default for single-app shape (Angular, Next,
 * etc.). Hides monorepo-only verbs from --help; the commands remain
 * CALLABLE (use `surface unhide` to restore).
 */
const SMALL_APP_PROFILE: ISurfaceProfile = {
  id: 'small-app',
  description:
    'Single-app / small-team default. Hides monorepo + pack-authoring + bundle verbs from --help.',
  source: 'builtin',
  hidden: [
    // Bundle / replay machinery — not used in single-app workflows.
    'bundle',
    'bundle apply-assist',
    'bundle apply-assist --resume',
    'bundle create',
    'bundle diff',
    'bundle graph',
    'bundle list',
    'bundle plan',
    'bundle replay',
    'bundle show',
    'bundle validate',
    // Reposet / multi-repo orchestration — irrelevant for a single app.
    'reposet',
    'reposet init',
    'reposet doctor',
    'reposet list',
    'reposet map',
    // Pack authoring — single apps rarely author packs.
    'pack',
    'pack author preview',
    'pack author pending',
    'pack author status',
    'pack author validate',
    'packs new',
    'packs sign',
    'packs verify',
    'packs release-check',
    'packs compat',
    'packs dev-status',
    'packs watch',
  ],
};

/**
 * `monorepo` profile. Default for monorepo / app-with-libs shapes.
 * Same as developer; explicit so a user can opt in.
 */
const MONOREPO_PROFILE: ISurfaceProfile = {
  id: 'monorepo',
  description:
    'Monorepo default. Full visible surface, including bundle / reposet / pack-authoring.',
  source: 'builtin',
};

/**
 * `pack-author` profile. Hides app-only verbs; keeps pack authoring
 * + signing + release-check prominent.
 */
const PACK_AUTHOR_PROFILE: ISurfaceProfile = {
  id: 'pack-author',
  description:
    'Pack author default. Hides app / runtime verbs; surfaces pack-* prominently.',
  source: 'builtin',
  hidden: [
    'dev',
    'dev start',
    'dev status',
    'dev report',
    'review',
    'review render-comment',
  ],
};

/**
 * `ci` profile. Hides interactive / app verbs; keeps gates +
 * read-only checks visible.
 */
const CI_PROFILE: ISurfaceProfile = {
  id: 'ci',
  description:
    'CI default. Hides interactive / write-source verbs; keeps gates + read-only checks visible.',
  source: 'builtin',
  hidden: [
    'dev',
    'dev start',
    'dev status',
    'dev report',
    'ask',
    'orchestrate',
  ],
};

/**
 * Generic machinery categories that are noise for an inline coding agent:
 * CI / release gates, pack maintenance & signing, bundle replay, provenance,
 * report generation, schema / governance / ingestion / lifecycle / polyglot /
 * integration tooling. Commands stay fully CALLABLE — the agent profile just
 * filters them from the agent-facing listing.
 */
const AGENT_HIDDEN_CATEGORIES: ReadonlySet<string> = new Set([
  'release',
  'ci',
  'bundles',
  'bundle',
  'packs',
  'pack-author',
  'provenance',
  'reports',
  'schemas',
  'governance',
  'ingestion',
  'lifecycle',
  'export',
  'polyglot',
  'integrations',
]);

/** Read-only discovery verbs kept visible even though their category is hidden,
 *  so an agent can still inspect packs. */
const AGENT_KEEP_VISIBLE: ReadonlySet<string> = new Set(['packs list', 'packs doctor']);

/** Interactive / write-source verbs hidden from the agent surface. */
const AGENT_INTERACTIVE_HIDDEN: readonly string[] = [
  'dev',
  'dev start',
  'dev status',
  'dev report',
  'orchestrate',
  'ask',
];

/**
 * Derive the hidden command list from machinery categories MECHANICALLY from the
 * catalogue, so it never drifts as commands are added/removed.
 */
function deriveHiddenByCategory(
  hiddenCats: ReadonlySet<string>,
  keep: ReadonlySet<string>,
): string[] {
  return COMMAND_CATALOG.filter((e) => hiddenCats.has(e.category) && !keep.has(e.command))
    .map((e) => e.command)
    .sort();
}

/**
 * `agent` profile. Optimized for inline coding-agent / MCP use. Hides
 * interactive verbs AND CI/release/pack-maintenance machinery; favors JSON-pipe
 * read surfaces. Every hidden command remains callable (hide != disable).
 */
const AGENT_PROFILE: ISurfaceProfile = {
  id: 'agent',
  description:
    'Agent / MCP-friendly default. Hides interactive verbs + CI/release/pack-maintenance machinery from the listing (commands stay callable); favors JSON-pipe read surfaces.',
  source: 'builtin',
  hidden: [
    ...new Set([
      ...AGENT_INTERACTIVE_HIDDEN,
      ...deriveHiddenByCategory(AGENT_HIDDEN_CATEGORIES, AGENT_KEEP_VISIBLE),
    ]),
  ],
};

/** Catalog of built-in profiles. */
export const BUILTIN_PROFILES: readonly ISurfaceProfile[] = Object.freeze([
  DEVELOPER_PROFILE,
  SMALL_APP_PROFILE,
  MONOREPO_PROFILE,
  PACK_AUTHOR_PROFILE,
  CI_PROFILE,
  AGENT_PROFILE,
]);

/** Build a map of all profiles (builtin + pack-contributed). */
export function indexProfiles(
  packProfiles: readonly ISurfaceProfile[] = [],
): Map<string, ISurfaceProfile> {
  const map = new Map<string, ISurfaceProfile>();
  for (const p of BUILTIN_PROFILES) map.set(p.id, p);
  // Pack profiles can override builtin profiles by id (intentional —
  // a pack that ships e.g. a 'monorepo-developer' profile gets first
  // dibs over any namespace collision).
  for (const p of packProfiles) map.set(p.id, p);
  return map;
}

/** Look up a profile by id; returns undefined if unknown. */
export function getProfile(
  id: string,
  packProfiles: readonly ISurfaceProfile[] = [],
): ISurfaceProfile | undefined {
  return indexProfiles(packProfiles).get(id);
}
