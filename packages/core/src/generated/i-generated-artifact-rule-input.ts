import type { SelectorListEntry } from '../liveness/selector-list-entry.ts';
import type { IGeneratedArtifactRule } from './generated-artifact-rule.ts';

/** The AUTHORED generated-artifact rule (round 13): `generatedGlob` takes a glob or `{ pattern, expectEmpty: true, reason? }`. */
export interface IGeneratedArtifactRuleInput extends Omit<IGeneratedArtifactRule, 'generatedGlob' | 'expectEmptyUnits'> {
  readonly generatedGlob: readonly SelectorListEntry[];
}
