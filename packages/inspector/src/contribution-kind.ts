/**
 * Every contribution kind the engine loads — one per manifest contribution
 * slot that has a loader (`CONTRIBUTION_FILE_KEYS`, @shrkcrft/plugin-api), plus
 * `path-convention` / `docs`, whose slots feed the path / knowledge loaders.
 *
 * Round 12 (12.1e): the inventory knew only the knowledge family and six
 * registries, so a registration hint, a gate-plane rule, a delegate recipe or
 * a construct facet contributed by a pack appeared on no contributions surface
 * — and neither did a rejected one. Every loader-backed slot now has a kind
 * (the inventory's `KIND_TO_SLOT` is a `Record` over this enum, so a kind
 * without a slot is a compile error, and an r76 lock holds every loader-backed
 * slot to a kind).
 */
export enum ContributionKind {
  Knowledge = 'knowledge',
  Rule = 'rule',
  Path = 'path',
  PathConvention = 'path-convention',
  Template = 'template',
  Pipeline = 'pipeline',
  Preset = 'preset',
  Boundary = 'boundary',
  ScaffoldPattern = 'scaffold-pattern',
  Policy = 'policy',
  Construct = 'construct',
  ConstructFacet = 'construct-facet',
  Playbook = 'playbook',
  SearchTuning = 'search-tuning',
  FeedbackRule = 'feedback-rule',
  Decision = 'decision',
  ContractTemplate = 'contract-template',
  MigrationProfile = 'migration-profile',
  ContextTest = 'context-test',
  AgentTest = 'agent-test',
  Helper = 'helper',
  TaskRoutingHint = 'task-routing-hint',
  RegistrationHint = 'registration-hint',
  Convention = 'convention',
  Docs = 'docs',
  DelegateRecipe = 'delegate-recipe',
  FrameworkExtractor = 'framework-extractor',
  WiringRule = 'wiring-rule',
  Registry = 'registry',
  RegistrationIdiom = 'registration-idiom',
  PolicyRule = 'policy-rule',
  ReusePrimitive = 'reuse-primitive',
  Baseline = 'baseline',
  GeneratedArtifact = 'generated-artifact',
  /** `docReferenceFiles` — the prose doc-reference plane (round 13: a declared slot). */
  DocReference = 'doc-reference',
}
