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

/** Which data-defined plane a rule belongs to. */
export type GatePlane =
  | 'wiring'
  | 'policy'
  | 'registry'
  | 'registration'
  | 'baseline'
  | 'generated'
  | 'doc-reference';

/** Every plane, in the order `shrk gates list` prints them. */
export const GATE_PLANES: readonly GatePlane[] = [
  'wiring',
  'policy',
  'registry',
  'registration',
  'baseline',
  'generated',
  'doc-reference',
];

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

/** Flatten every declared rule across every plane into one iterable list. */
export function collectGateRules(planes: IGatePlanes): IGateRuleView[] {
  const out: IGateRuleView[] = [];
  for (const r of planes.wiringRules ?? []) {
    out.push({
      id: r.id,
      plane: 'wiring',
      ...(r.description ? { description: r.description } : {}),
      severity: r.severity ?? 'error',
      failOnEmpty: failsWhenEmpty(r),
      ...(r.selfTest ? { selfTest: r.selfTest } : {}),
      raw: r,
    });
  }
  for (const r of planes.policyRules ?? []) {
    out.push({
      id: r.id,
      plane: 'policy',
      ...(r.description ? { description: r.description } : {}),
      severity: r.severity ?? 'error',
      failOnEmpty: failsWhenEmpty(r),
      ...(r.selfTest ? { selfTest: r.selfTest } : {}),
      raw: r,
    });
  }
  for (const r of planes.registries ?? []) {
    out.push({
      id: r.name,
      plane: 'registry',
      ...(r.description ? { description: r.description } : {}),
      // A registry is an inventory, not a gate — it never fails a build on its
      // own, so it carries no severity of its own. A `selfTest` still applies:
      // an inventory whose selector went stale reports an empty registry as
      // fact, which is worse than a failing gate because nothing looks wrong.
      severity: 'warning',
      failOnEmpty: false,
      ...(r.selfTest ? { selfTest: r.selfTest } : {}),
      raw: r,
    });
  }
  for (const r of planes.registrationGraph ?? []) {
    out.push({
      id: r.name,
      plane: 'registration',
      ...(r.description ? { description: r.description } : {}),
      severity: 'warning',
      failOnEmpty: false,
      ...(r.selfTest ? { selfTest: r.selfTest } : {}),
      raw: r,
    });
  }
  for (const r of planes.baselines ?? []) {
    out.push({
      id: r.id,
      plane: 'baseline',
      ...(r.description ? { description: r.description } : {}),
      severity: r.severity ?? 'error',
      failOnEmpty: failsWhenEmpty(r),
      ...(r.expectEmpty === true ? { expectEmpty: true } : {}),
      ...(r.selfTest ? { selfTest: r.selfTest } : {}),
      raw: r,
    });
  }
  for (const r of planes.docReferences ?? []) {
    out.push({
      id: r.id,
      plane: 'doc-reference',
      ...(r.description ? { description: r.description } : {}),
      severity: r.severity ?? 'error',
      failOnEmpty: failsWhenEmpty(r),
      ...(r.selfTest ? { selfTest: r.selfTest } : {}),
      raw: r,
    });
  }
  for (const r of planes.generatedArtifacts ?? []) {
    out.push({
      id: r.id,
      plane: 'generated',
      ...(r.description ? { description: r.description } : {}),
      severity: r.severity ?? 'error',
      failOnEmpty: failsWhenEmpty(r),
      ...(r.selfTest ? { selfTest: r.selfTest } : {}),
      raw: r,
    });
  }
  return out;
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
