import {
  failsWhenEmpty,
  type IBaselineRule,
  type IDocReferenceRule,
  type IGeneratedArtifactRule,
  type IPolicyRule,
  type IRegistrationIdiom,
  type IRegistryDeclaration,
  type IRuleSelfTest,
  type IWiringRule,
} from '@shrkcrft/core';
import { GATE_PLANE_CONFIG_KEY, GATE_PLANE_ORDER, type GatePlane } from '@shrkcrft/config';

/** Which data-defined plane a rule belongs to — THE config-schema type (`@shrkcrft/config`). */
export type { GatePlane } from '@shrkcrft/config';

/**
 * Every plane, in the order `shrk gates list` prints them — THE list beside
 * the config schema (`GATE_PLANE_ORDER`), never a CLI copy of it.
 */
export const GATE_PLANES: readonly GatePlane[] = GATE_PLANE_ORDER;

/**
 * One data-defined rule, normalized across planes.
 *
 * The trust layer's whole job is to answer "what did this rule actually match?"
 * for ANY rule, so it needs one shape to iterate. The plane-specific rule object
 * rides along in `raw` for the explain dispatch.
 */
export interface IGateRuleView {
  readonly id: string;
  readonly plane: GatePlane;
  readonly description?: string;
  readonly severity: 'error' | 'warning';
  /** True when a zero-match is a hard failure rather than a loud skip. */
  readonly failOnEmpty: boolean;
  /**
   * True when an EMPTY result is the rule's passing state (a fence). The
   * loud-skip contract is inverted for these, and only for these.
   */
  readonly expectEmpty?: boolean;
  readonly selfTest?: IRuleSelfTest;
  /** The underlying rule, for the plane-specific explainer. */
  readonly raw:
    | IWiringRule
    | IPolicyRule
    | IRegistryDeclaration
    | IRegistrationIdiom
    | IBaselineRule
    | IGeneratedArtifactRule
    | IDocReferenceRule;
}

/** The config planes this view is built from. */
export interface IGatePlanes {
  readonly wiringRules?: readonly IWiringRule[];
  readonly policyRules?: readonly IPolicyRule[];
  readonly registries?: readonly IRegistryDeclaration[];
  readonly registrationGraph?: readonly IRegistrationIdiom[];
  readonly baselines?: readonly IBaselineRule[];
  readonly generatedArtifacts?: readonly IGeneratedArtifactRule[];
  readonly docReferences?: readonly IDocReferenceRule[];
}

/**
 * One view builder per plane, keyed by {@link GatePlane} so the record is
 * exhaustive: a plane added to the config list fails the build here until it
 * has a builder. Each reads its rules under THE config key
 * (`GATE_PLANE_CONFIG_KEY`) — no plane → key name is spelled in the CLI.
 */
const PLANE_VIEWS: { readonly [P in GatePlane]: (planes: IGatePlanes) => IGateRuleView[] } = {
  wiring: (planes) =>
    (planes[GATE_PLANE_CONFIG_KEY.wiring] ?? []).map(
      (r): IGateRuleView => ({
        id: r.id,
        plane: 'wiring',
        ...(r.description ? { description: r.description } : {}),
        severity: r.severity ?? 'error',
        failOnEmpty: failsWhenEmpty(r),
        ...(r.selfTest ? { selfTest: r.selfTest } : {}),
        raw: r,
      }),
    ),
  policy: (planes) =>
    (planes[GATE_PLANE_CONFIG_KEY.policy] ?? []).map(
      (r): IGateRuleView => ({
        id: r.id,
        plane: 'policy',
        ...(r.description ? { description: r.description } : {}),
        severity: r.severity ?? 'error',
        failOnEmpty: failsWhenEmpty(r),
        ...(r.selfTest ? { selfTest: r.selfTest } : {}),
        raw: r,
      }),
    ),
  registry: (planes) =>
    (planes[GATE_PLANE_CONFIG_KEY.registry] ?? []).map(
      (r): IGateRuleView => ({
        id: r.name,
        plane: 'registry',
        ...(r.description ? { description: r.description } : {}),
        // A registry is an inventory, not a gate — it never fails a build on its
        // own, so it carries no severity of its own. A `selfTest` still applies:
        // an inventory whose selector went stale reports an empty registry as
        // fact, which is worse than a failing gate because nothing looks wrong.
        // `failOnEmpty` goes through the one shared helper; with no severity the
        // default stays `false` (a loud skip), and an explicit `true` promotes it.
        severity: 'warning',
        failOnEmpty: failsWhenEmpty({
          ...(r.failOnEmpty !== undefined ? { failOnEmpty: r.failOnEmpty } : {}),
          severity: 'warning',
        }),
        ...(r.selfTest ? { selfTest: r.selfTest } : {}),
        raw: r,
      }),
    ),
  registration: (planes) =>
    (planes[GATE_PLANE_CONFIG_KEY.registration] ?? []).map(
      (r): IGateRuleView => ({
        id: r.name,
        plane: 'registration',
        ...(r.description ? { description: r.description } : {}),
        severity: 'warning',
        failOnEmpty: failsWhenEmpty({
          ...(r.failOnEmpty !== undefined ? { failOnEmpty: r.failOnEmpty } : {}),
          severity: 'warning',
        }),
        ...(r.selfTest ? { selfTest: r.selfTest } : {}),
        raw: r,
      }),
    ),
  baseline: (planes) =>
    (planes[GATE_PLANE_CONFIG_KEY.baseline] ?? []).map(
      (r): IGateRuleView => ({
        id: r.id,
        plane: 'baseline',
        ...(r.description ? { description: r.description } : {}),
        severity: r.severity ?? 'error',
        failOnEmpty: failsWhenEmpty(r),
        ...(r.expectEmpty === true ? { expectEmpty: true } : {}),
        ...(r.selfTest ? { selfTest: r.selfTest } : {}),
        raw: r,
      }),
    ),
  generated: (planes) =>
    (planes[GATE_PLANE_CONFIG_KEY.generated] ?? []).map(
      (r): IGateRuleView => ({
        id: r.id,
        plane: 'generated',
        ...(r.description ? { description: r.description } : {}),
        severity: r.severity ?? 'error',
        failOnEmpty: failsWhenEmpty(r),
        ...(r.selfTest ? { selfTest: r.selfTest } : {}),
        raw: r,
      }),
    ),
  'doc-reference': (planes) =>
    (planes[GATE_PLANE_CONFIG_KEY['doc-reference']] ?? []).map(
      (r): IGateRuleView => ({
        id: r.id,
        plane: 'doc-reference',
        ...(r.description ? { description: r.description } : {}),
        severity: r.severity ?? 'error',
        failOnEmpty: failsWhenEmpty(r),
        ...(r.selfTest ? { selfTest: r.selfTest } : {}),
        raw: r,
      }),
    ),
};

/** Flatten every declared rule across every plane into one iterable list, in {@link GATE_PLANES} order. */
export function collectGateRules(planes: IGatePlanes): IGateRuleView[] {
  return GATE_PLANES.flatMap((plane) => PLANE_VIEWS[plane](planes));
}

/**
 * The "` · scan: code (N chars blanked)`" suffix for an explain line.
 *
 * A zone is the one setting that legitimately makes a rule match LESS while
 * still reading green, so every surface that reports what a rule extracted also
 * reports what the zone removed to get there. Empty string when the rule scans
 * raw text, so an unzoned rule's output is byte-identical to before.
 */
export function scanNote(zone?: string, blankedChars?: number): string {
  if (!zone || zone === 'all') return '';
  const n = blankedChars ?? 0;
  return `  · scan: ${zone} (${n} char${n === 1 ? '' : 's'} blanked)`;
}
