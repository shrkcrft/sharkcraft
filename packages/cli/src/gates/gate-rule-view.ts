import {
  failsWhenEmpty,
  type IBaselineRule,
  type IGeneratedArtifactRule,
  type IPolicyRule,
  type IRegistrationIdiom,
  type IRegistryDeclaration,
  type IRuleSelfTest,
  type IWiringRule,
} from '@shrkcrft/core';

/** Which data-defined plane a rule belongs to. */
export type GatePlane = 'wiring' | 'policy' | 'registry' | 'registration' | 'baseline' | 'generated';

/** Every plane, in the order `shrk gates list` prints them. */
export const GATE_PLANES: readonly GatePlane[] = [
  'wiring',
  'policy',
  'registry',
  'registration',
  'baseline',
  'generated',
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
  readonly selfTest?: IRuleSelfTest;
  /** The underlying rule, for the plane-specific explainer. */
  readonly raw:
    | IWiringRule
    | IPolicyRule
    | IRegistryDeclaration
    | IRegistrationIdiom
    | IBaselineRule
    | IGeneratedArtifactRule;
}

/** The config planes this view is built from. */
export interface IGatePlanes {
  readonly wiringRules?: readonly IWiringRule[];
  readonly policyRules?: readonly IPolicyRule[];
  readonly registries?: readonly IRegistryDeclaration[];
  readonly registrationGraph?: readonly IRegistrationIdiom[];
  readonly baselines?: readonly IBaselineRule[];
  readonly generatedArtifacts?: readonly IGeneratedArtifactRule[];
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
      // own, so it carries no severity of its own.
      severity: 'warning',
      failOnEmpty: false,
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
