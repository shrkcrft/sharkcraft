import type { IMarkableUnitListSpec } from './i-markable-unit-list-spec.ts';
import { MarkableListOwner } from './markable-list-owner.ts';
import { MarkableUnitList } from './markable-unit-list.ts';
import { UnitDeadWeight } from './unit-dead-weight.ts';
import { UnitEntryForm } from './unit-entry-form.ts';
import { UnitPolarity } from './unit-polarity.ts';

const GATE_GLOB_WENT_LIVE =
  "the glob matches a file (raw, before the list's own negations: `IDeadGlobUnit.matched > 0` / not in `dead`); a `!` entry, when it excludes a file; effective once a match survives the list's negations";

/** An extraction-source `files` list (`IWiringSource`), advisory like every gate-plane glob. */
function sourceFiles(container: string): IMarkableUnitListSpec {
  return {
    container,
    carrier: 'IWiringSource',
    listPath: 'files',
    form: UnitEntryForm.List,
    polarity: UnitPolarity.Any,
    weight: UnitDeadWeight.Advisory,
    unitLabel: 'globs',
    wentLive: GATE_GLOB_WENT_LIVE,
    owner: MarkableListOwner.GatePlanes,
  };
}

/** A rule-level glob list on a gate plane, advisory. */
function ruleGlobs(container: string, carrier: string, listPath: string): IMarkableUnitListSpec {
  return { ...sourceFiles(container), carrier, listPath };
}

/**
 * THE table of markable lists — one spec per `MarkableUnitList`, exhaustive by
 * type. The r77 census iterates it; docs/intended-empty.md renders it.
 *
 * Source-carried lists (`files`, `to.files`) sit on the `IWiringSource` they
 * belong to: a settle spanning a rule's several sources qualifies each list with
 * the source's label (`qualifyListPath('declared', 'files')` → `declared.files`,
 * the same label `gateRuleLabeledSources` prints).
 */
export const MARKABLE_UNIT_LISTS: Readonly<Record<MarkableUnitList, IMarkableUnitListSpec>> = {
  // ── boundaries ─────────────────────────────────────────────────────────
  [MarkableUnitList.BoundaryFrom]: {
    container: 'boundary rule',
    carrier: 'IBoundaryRule',
    listPath: 'from',
    form: UnitEntryForm.List,
    polarity: UnitPolarity.Inclusion,
    weight: UnitDeadWeight.Coverage,
    unitLabel: 'scope globs',
    wentLive:
      'a scanned file matches the glob (raw, before exemptions: anyPerGlob > 0); effective once a governed (non-exempt) file does (governedPerGlob > 0)',
    owner: MarkableListOwner.Boundaries,
  },
  [MarkableUnitList.BoundaryFromNegation]: {
    container: 'boundary rule',
    carrier: 'IBoundaryRule',
    listPath: 'from',
    form: UnitEntryForm.List,
    polarity: UnitPolarity.Negation,
    weight: UnitDeadWeight.Advisory,
    unitLabel: 'exemptions',
    wentLive: "it exempts a file the rule's from globs match (exemptPerIndex > 0)",
    owner: MarkableListOwner.Boundaries,
  },
  [MarkableUnitList.BoundaryExemptFiles]: {
    container: 'boundary rule',
    carrier: 'IBoundaryRule',
    listPath: 'exemptFiles',
    form: UnitEntryForm.List,
    polarity: UnitPolarity.Any,
    weight: UnitDeadWeight.Advisory,
    unitLabel: 'exemptions',
    wentLive: "it exempts a file the rule's from globs match (exemptPerIndex > 0)",
    owner: MarkableListOwner.Boundaries,
  },
  [MarkableUnitList.BoundaryForbiddenImports]: {
    container: 'boundary rule',
    carrier: 'IBoundaryRule',
    listPath: 'forbiddenImports',
    form: UnitEntryForm.List,
    polarity: UnitPolarity.Any,
    weight: UnitDeadWeight.Advisory,
    unitLabel: 'forbidden patterns',
    wentLive: '`resolvable`: an import, a workspace/dependency package name, a tsconfig alias or a file names it',
    owner: MarkableListOwner.Boundaries,
  },
  [MarkableUnitList.BoundaryAllowedImports]: {
    container: 'boundary rule',
    carrier: 'IBoundaryRule',
    listPath: 'allowedImports',
    form: UnitEntryForm.List,
    polarity: UnitPolarity.Any,
    weight: UnitDeadWeight.Advisory,
    unitLabel: 'allowed patterns',
    wentLive: "an import matches it, or a package / alias / file resolves it (exact): hits > 0 || couldResolve(p, 'exact')",
    owner: MarkableListOwner.Boundaries,
  },
  // ── gate planes ────────────────────────────────────────────────────────
  [MarkableUnitList.WiringDeclaredFiles]: sourceFiles('wiringRules[].declared'),
  [MarkableUnitList.WiringRegisteredFiles]: sourceFiles('wiringRules[].registered (one source, or each of a list)'),
  [MarkableUnitList.WiringChainFiles]: sourceFiles('wiringRules[].chain[]'),
  [MarkableUnitList.RegistrySourceFiles]: sourceFiles('registries[].source'),
  [MarkableUnitList.RegistryConsumerFiles]: sourceFiles('registries[].consumer'),
  [MarkableUnitList.RegistrationDeclaredFiles]: sourceFiles('registrationGraph[].declared'),
  [MarkableUnitList.RegistrationProvidedFiles]: sourceFiles('registrationGraph[].provided'),
  [MarkableUnitList.RegistrationConsumedFiles]: sourceFiles('registrationGraph[].consumed'),
  [MarkableUnitList.BaselineComputeSourceFiles]: sourceFiles('baselines[].compute.source'),
  [MarkableUnitList.BaselineWatchFiles]: ruleGlobs('baselines[]', 'IBaselineRule', 'watchFiles'),
  [MarkableUnitList.ExtractorFiles]: sourceFiles('extractors.<id> (top-level, local config only)'),
  [MarkableUnitList.ImportEdgesToFiles]: {
    ...sourceFiles('an import-edges extraction source (extract: import-edges)'),
    listPath: 'to.files',
    wentLive: 'a file matches the glob (judged for liveness from round 13 on — a typo no longer passes silently)',
  },
  [MarkableUnitList.PolicyFiles]: ruleGlobs('policyRules[]', 'IPolicyRule', 'files'),
  [MarkableUnitList.GeneratedGlob]: ruleGlobs('generatedArtifacts[]', 'IGeneratedArtifactRule', 'generatedGlob'),
  [MarkableUnitList.DocReferenceFiles]: ruleGlobs('docReferences[]', 'IDocReferenceRule', 'files'),
  // ── assets ─────────────────────────────────────────────────────────────
  [MarkableUnitList.RegistrationHintTargetGlobs]: {
    container: 'registration hint',
    carrier: 'IRegistrationHint',
    listPath: 'discovery.targetGlobs',
    form: UnitEntryForm.List,
    polarity: UnitPolarity.Any,
    weight: UnitDeadWeight.Coverage,
    unitLabel: 'discovery selectors',
    wentLive: 'the discovery glob matches a file (perGlob.matched > 0)',
    owner: MarkableListOwner.Assets,
  },
  [MarkableUnitList.RegistrationHintTargetFile]: {
    container: 'registration hint',
    carrier: 'IRegistrationHint',
    listPath: 'discovery.targetFile',
    form: UnitEntryForm.Scalar,
    polarity: UnitPolarity.Any,
    weight: UnitDeadWeight.Coverage,
    unitLabel: 'discovery selectors',
    wentLive: 'the target file exists',
    owner: MarkableListOwner.Assets,
  },
  [MarkableUnitList.ScaffoldPatternMatchPaths]: {
    container: 'scaffold pattern',
    carrier: 'IScaffoldPattern',
    listPath: 'matchPaths',
    form: UnitEntryForm.List,
    polarity: UnitPolarity.Any,
    weight: UnitDeadWeight.Coverage,
    unitLabel: 'matchPaths globs',
    wentLive:
      'the glob matches a file (perMatchPath.files > 0); the derived pattern-level unit is intended-empty iff every one of its globs is',
    owner: MarkableListOwner.Assets,
  },
  [MarkableUnitList.SearchTuningBoostIds]: {
    container: 'search tuning',
    carrier: 'ISearchTuning',
    listPath: 'boostIds',
    form: UnitEntryForm.WeightMap,
    polarity: UnitPolarity.Any,
    weight: UnitDeadWeight.Coverage,
    unitLabel: 'boost keys',
    wentLive:
      'the key resolves (SearchTuningKeyStatus.Resolved); only a Missing key can be intended-empty — unprefixed, unknown-kind and excluded keys are defects and refuse a marker',
    owner: MarkableListOwner.Assets,
  },
  [MarkableUnitList.SearchTuningTaskHintBoostIds]: {
    container: 'search tuning taskHints[]',
    carrier: 'ISearchTuning',
    listPath: 'taskHints[i].boostIds',
    form: UnitEntryForm.WeightMap,
    polarity: UnitPolarity.Any,
    weight: UnitDeadWeight.Coverage,
    unitLabel: 'boost keys',
    wentLive: 'the key resolves (SearchTuningKeyStatus.Resolved), as for boostIds',
    owner: MarkableListOwner.Assets,
  },
};
