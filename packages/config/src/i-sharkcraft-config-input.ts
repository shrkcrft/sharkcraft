import type {
  IBaselineRuleInput,
  IDocReferenceRuleInput,
  IGeneratedArtifactRuleInput,
  IPolicyRuleInput,
  IRegistrationIdiomInput,
  IRegistryDeclarationInput,
  IWiringRuleInput,
  IWiringSourceInput,
} from '@shrkcrft/core';
import type { ISharkCraftConfig } from './sharkcraft-config.ts';

/**
 * The AUTHORED `sharkcraft.config.ts` shape (round 13): {@link ISharkCraftConfig}
 * with every gate plane's markable lists widened to `string | { pattern,
 * expectEmpty: true, reason? }` (docs/intended-empty.md). `defineSharkCraftConfig`
 * takes it; the loader validates it (zod) and normalises it
 * (`normalizePlaneConfig`) into the loaded {@link ISharkCraftConfig}, whose
 * lists are plain strings and whose markers ride in `expectEmptyUnits`.
 */
export interface ISharkCraftConfigInput
  extends Omit<
    ISharkCraftConfig,
    | 'extractors'
    | 'wiringRules'
    | 'registries'
    | 'registrationGraph'
    | 'policyRules'
    | 'baselines'
    | 'generatedArtifacts'
    | 'docReferences'
  > {
  extractors?: Readonly<Record<string, IWiringSourceInput>>;
  wiringRules?: readonly IWiringRuleInput[];
  registries?: readonly IRegistryDeclarationInput[];
  registrationGraph?: readonly IRegistrationIdiomInput[];
  policyRules?: readonly IPolicyRuleInput[];
  baselines?: readonly IBaselineRuleInput[];
  generatedArtifacts?: readonly IGeneratedArtifactRuleInput[];
  docReferences?: readonly IDocReferenceRuleInput[];
}
