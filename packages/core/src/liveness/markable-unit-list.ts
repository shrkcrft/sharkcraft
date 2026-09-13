/**
 * Every selector list whose units can be reported dead AND may carry an
 * `expectEmpty` marker (round 13). A closed set: `MARKABLE_UNIT_LISTS` is an
 * exhaustive `Record` over it and so is the r77 census, so adding a list
 * without its spec or its census case fails tsc.
 *
 * Values are stable ids (`<container>.<list>`). Where the list lives, what
 * carries its ledger and how its units weigh are in the spec, not the name.
 */
export enum MarkableUnitList {
  // ── boundaries ─────────────────────────────────────────────────────────
  BoundaryFrom = 'boundary.from',
  BoundaryFromNegation = 'boundary.from.negation',
  BoundaryExemptFiles = 'boundary.exemptFiles',
  BoundaryForbiddenImports = 'boundary.forbiddenImports',
  BoundaryAllowedImports = 'boundary.allowedImports',
  // ── gate planes ────────────────────────────────────────────────────────
  WiringDeclaredFiles = 'wiringRules.declared.files',
  WiringRegisteredFiles = 'wiringRules.registered.files',
  WiringChainFiles = 'wiringRules.chain.files',
  RegistrySourceFiles = 'registries.source.files',
  RegistryConsumerFiles = 'registries.consumer.files',
  RegistrationDeclaredFiles = 'registrationGraph.declared.files',
  RegistrationProvidedFiles = 'registrationGraph.provided.files',
  RegistrationConsumedFiles = 'registrationGraph.consumed.files',
  BaselineComputeSourceFiles = 'baselines.compute.source.files',
  BaselineWatchFiles = 'baselines.watchFiles',
  ExtractorFiles = 'extractors.files',
  ImportEdgesToFiles = 'import-edges.to.files',
  PolicyFiles = 'policyRules.files',
  GeneratedGlob = 'generatedArtifacts.generatedGlob',
  DocReferenceFiles = 'docReferences.files',
  // ── assets ─────────────────────────────────────────────────────────────
  RegistrationHintTargetGlobs = 'registrationHint.discovery.targetGlobs',
  RegistrationHintTargetFile = 'registrationHint.discovery.targetFile',
  ScaffoldPatternMatchPaths = 'scaffoldPattern.matchPaths',
  SearchTuningBoostIds = 'searchTuning.boostIds',
  SearchTuningTaskHintBoostIds = 'searchTuning.taskHints.boostIds',
}
