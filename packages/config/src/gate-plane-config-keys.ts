import type { GatePlane } from './gate-plane.ts';
import type { ISharkCraftConfig } from './sharkcraft-config.ts';

/**
 * THE map from each data-defined gate plane to the `sharkcraft.config.ts` key
 * its rules live under, in `shrk gates list` order (insertion order).
 *
 * It describes the config SCHEMA, so it lives beside it. The CLI's
 * `collectGateRules` / `GATE_PLANES` / `$use` resolution map and the
 * inspector's `declaredGatePlaneRules` (the quality report's plane row) all
 * read this one record. Round 11 review R12-AUTH-1: each used to keep its own
 * copy — three lists held together only by a parity test. The
 * `Record<GatePlane, keyof ISharkCraftConfig>` constraint makes it exhaustive
 * and keeps every key a real config key: a plane added to {@link GatePlane}
 * fails the build here until its key is named, and the CLI's per-plane view
 * builders are keyed by the same type.
 */
export const GATE_PLANE_CONFIG_KEY = {
  wiring: 'wiringRules',
  policy: 'policyRules',
  registry: 'registries',
  registration: 'registrationGraph',
  baseline: 'baselines',
  generated: 'generatedArtifacts',
  'doc-reference': 'docReferences',
} as const satisfies Readonly<Record<GatePlane, keyof ISharkCraftConfig>>;

/** Every gate plane, in `shrk gates list` order — the keys of {@link GATE_PLANE_CONFIG_KEY}. */
export const GATE_PLANE_ORDER: readonly GatePlane[] = Object.freeze(Object.keys(GATE_PLANE_CONFIG_KEY) as GatePlane[]);
