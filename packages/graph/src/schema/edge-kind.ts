/**
 * Edge kinds in the code graph.
 *
 * MVP populates the "Code structure" group. Symbol-reference edges are
 * reserved for Wave 3; bridge edges are reserved for Wave 2.
 */
export enum EdgeKind {
  // ── Code structure (MVP) ─────────────────────────────────────────────
  ImportsFile = 'imports-file',
  DeclaresSymbol = 'declares-symbol',
  ReExportsSymbol = 're-exports-symbol',
  BelongsToPackage = 'belongs-to-package',
  PackageDependsOn = 'package-depends-on',

  // ── Symbol references (reserved, Wave 3) ─────────────────────────────
  ReferencesSymbol = 'references-symbol',
  CallsSymbol = 'calls-symbol',
  ExtendsSymbol = 'extends-symbol',
  ImplementsSymbol = 'implements-symbol',

  // ── Bridge to assets (reserved, Wave 2) ──────────────────────────────
  AppliesRule = 'applies-rule',
  ViolatesBoundary = 'violates-boundary',
  MatchesPath = 'matches-path',
  CoveredByTemplate = 'covered-by-template',
  CoveredByPipeline = 'covered-by-pipeline',
  ContributedByPack = 'contributed-by-pack',
  ContainsKnowledge = 'contains-knowledge',

  // ── Framework-aware edges (Wave 7) ───────────────────────────────────
  /** File declares a framework entity (e.g. controller/component/module). */
  FrameworkDeclares = 'framework-declares',
  /** Controller / route handler → HTTP route. */
  HandlesRoute = 'handles-route',
  /** Component → hook it uses. */
  UsesHook = 'uses-hook',
}
