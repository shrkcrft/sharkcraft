import type { IWiringRule, IWiringSource } from '@shrkcrft/core';
import type { ILabeledSource } from '../extract/i-labeled-source.ts';

/**
 * THE enumeration of a wiring rule's sources, each named by its side —
 * `declared`, `registered` (or `registered[i]` when a rule unions several
 * sinks), `chain[i]`. `gates coverage` / `gates explain` (the CLI's
 * `gateRuleLabeledSources`) and the wiring engine's liveness settle
 * (`runWiring`) both read it, so a marker or a dead glob is named by one side
 * label on every surface.
 */
export function wiringLabeledSources(rule: IWiringRule): readonly ILabeledSource[] {
  const registered: readonly IWiringSource[] = Array.isArray(rule.registered)
    ? (rule.registered as readonly IWiringSource[])
    : rule.registered
      ? [rule.registered as IWiringSource]
      : [];
  return [
    ...(rule.declared ? [{ label: 'declared', source: rule.declared }] : []),
    ...registered.map((source, i) => ({ label: registered.length > 1 ? `registered[${i}]` : 'registered', source })),
    ...(rule.chain ?? []).map((source, i) => ({ label: `chain[${i}]`, source })),
  ];
}
