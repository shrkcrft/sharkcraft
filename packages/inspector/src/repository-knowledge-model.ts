import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  recommendPresets,
  type IPresetRecommendation,
} from '@shrkcrft/presets';
import { PackageManager } from '@shrkcrft/workspace';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  buildOnboardingPlan,
  type IInferredBoundaryRule,
  type IInferredPathConvention,
  type IInferredPipeline,
  type IInferredRule,
  type IInferredTemplateCandidate,
  type IInferredVerificationCommand,
  type IOnboardingPlan,
} from './onboarding.ts';
import {
  buildAreaMap,
  type IAreaMap,
} from './area-map.ts';
import { listConstructs, loadConstructs, type IConstruct } from './construct-registry.ts';
import { analyzeImportGraph, type IImportGraphAnalysis } from './import-graph-analysis.ts';
import {
  buildGeneratedCodeReport,
  type IGeneratedCodeReport,
} from './generated-code.ts';
import {
  buildContradictionReport,
  type IContradictionReport,
} from './contradictions.ts';
import {
  buildStabilityMap,
  type IStabilityMap,
  StabilityKind,
} from './stability-map.ts';
import {
  GeneratedScanDepth,
} from './generated-code.ts';
import {
  buildPolyglotBoundaryReport,
  computePolyglotTestImpact,
  detectLanguageProfiles,
  buildLanguageCommandReport,
  scanPolyglotDependencies,
  suggestLanguageBoundaries,
  LanguageId,
  type ILanguageProfileReport,
  type ILanguageCommandReport,
  type IPolyglotDependencyGraph,
  type IPolyglotBoundaryReport,
  type ILanguageBoundarySuggestionReport,
  type IPolyglotTestImpact,
} from './languages/index.ts';

export const REPOSITORY_KNOWLEDGE_MODEL_SCHEMA = 'sharkcraft.repository-knowledge-model/v1';

export enum IngestDepth {
  Shallow = 'shallow',
  Standard = 'standard',
  Deep = 'deep',
  Extreme = 'extreme',
}

export enum IngestSection {
  RepositoryOverview = 'repositoryOverview',
  ArchitectureModel = 'architectureModel',
  BusinessLogicModel = 'businessLogicModel',
  RulesAndConventions = 'rulesAndConventions',
  DependencyBoundaries = 'dependencyBoundaries',
  DomainMap = 'domainMap',
  WorkflowMap = 'workflowMap',
  ChangeProtocol = 'changeProtocol',
  RiskAreas = 'riskAreas',
  Contradictions = 'contradictions',
  OpenQuestions = 'openQuestions',
  GeneratedVsHandwritten = 'generatedVsHandwritten',
  StableExperimentalDeprecated = 'stableExperimentalDeprecated',
  TaskContextHints = 'taskContextHints',
  RecommendedSharkCraftFiles = 'recommendedSharkCraftFiles',
}

export const ALL_INGEST_SECTIONS: readonly IngestSection[] = Object.values(IngestSection);

export interface IRepositoryOverview {
  projectName: string;
  description?: string;
  packageManager: string;
  frameworks: readonly string[];
  topLevelDirs: readonly string[];
  knownScripts: readonly string[];
  hasSharkcraftFolder: boolean;
  monorepo: boolean;
  detectedLanguages: readonly string[];
}

export interface IArchitectureLayerSummary {
  id: string;
  description: string;
  paths: readonly string[];
  fileCount: number;
}

export interface IArchitectureModel {
  layers: readonly IArchitectureLayerSummary[];
  /** Public API surfaces (paths whose deep imports should be forbidden). */
  publicApis: readonly string[];
  /** Notes about cycles or imports that violate the inferred layer order. */
  notes: readonly string[];
}

export interface IBusinessConcept {
  id: string;
  title: string;
  source: 'docs' | 'folder' | 'construct' | 'pack' | 'config';
  /** Free-form summary in 1–3 lines. */
  summary: string;
  paths: readonly string[];
  /** Domain workflows in which this concept participates. */
  relatedWorkflows: readonly string[];
}

export interface IBusinessLogicModel {
  entities: readonly IBusinessConcept[];
  workflows: readonly IBusinessConcept[];
  invariants: readonly string[];
}

export interface IDomainAreaEntry {
  id: string;
  paths: readonly string[];
  kind: string;
  fileCount: number;
}

export interface IDomainMap {
  areas: readonly IDomainAreaEntry[];
  constructs: readonly { id: string; title: string; paths: readonly string[] }[];
}

export interface IWorkflowEntry {
  id: string;
  title: string;
  source: 'docs' | 'scripts' | 'pipelines' | 'inferred';
  steps: readonly string[];
}

export interface IWorkflowMap {
  workflows: readonly IWorkflowEntry[];
}

export interface IChangeProtocolEntry {
  id: string;
  title: string;
  steps: readonly string[];
  recommendedCommands: readonly string[];
}

export interface IChangeProtocol {
  entries: readonly IChangeProtocolEntry[];
}

export interface IRiskAreaEntry {
  id: string;
  path: string;
  reason: string;
  recommendation: string;
  /** Higher = riskier. 0–100. */
  score: number;
}

export interface ITaskContextHint {
  trigger: string;
  hint: string;
  recommendedCommand?: string;
}

export interface IRecommendedSharkCraftFile {
  /** sharkcraft/X.ts or sharkcraft/ingestion/generated/X.draft.ts */
  target: string;
  reason: string;
  entries: readonly IDraftEntryRef[];
}

export interface IDraftEntryRef {
  id: string;
  /** Why this entry was placed in this file. */
  reason: string;
  /** What the entry represents (rule|path|template|...) */
  kind: string;
}

export interface IRepositoryKnowledgeModelConfidence {
  /** 0–100. */
  overall: number;
  perSection: Readonly<Record<IngestSection, number>>;
  /** What signals were strong vs weak. */
  notes: readonly string[];
}

export interface ILanguageRiskNote {
  language: string;
  note: string;
}

export interface ILanguageGeneratedSignal {
  language: string;
  signal: string;
  paths: readonly string[];
}

export interface ILanguageStabilitySignal {
  language: string;
  kind: string;
  paths: readonly string[];
}

export interface IRepositoryKnowledgeModel {
  schema: typeof REPOSITORY_KNOWLEDGE_MODEL_SCHEMA;
  projectRoot: string;
  depth: IngestDepth;
  presets: readonly IPresetRecommendation[];
  forcedPresetIds: readonly string[];
  transformationalIntents: readonly string[];
  selectedSections: readonly IngestSection[];
  repositoryOverview: IRepositoryOverview;
  /** Language-aware sections. */
  languageProfiles?: ILanguageProfileReport;
  languageCommands?: ILanguageCommandReport;
  polyglotDependencySummary?: IPolyglotDependencyGraph;
  polyglotTestImpactSummary?: IPolyglotTestImpact;
  languageBoundarySuggestions?: ILanguageBoundarySuggestionReport;
  polyglotBoundaryReport?: IPolyglotBoundaryReport;
  languageRiskNotes?: readonly ILanguageRiskNote[];
  languageGeneratedCodeSignals?: readonly ILanguageGeneratedSignal[];
  languageStabilitySignals?: readonly ILanguageStabilitySignal[];
  architectureModel: IArchitectureModel;
  businessLogicModel: IBusinessLogicModel;
  rulesAndConventions: {
    rules: readonly IInferredRule[];
    paths: readonly IInferredPathConvention[];
    verificationCommands: readonly IInferredVerificationCommand[];
  };
  dependencyBoundaries: {
    rules: readonly IInferredBoundaryRule[];
    importGraphSummary: {
      nodeCount: number;
      edgeCount: number;
      cycles: readonly string[];
    };
  };
  domainMap: IDomainMap;
  workflowMap: IWorkflowMap;
  changeProtocol: IChangeProtocol;
  riskAreas: readonly IRiskAreaEntry[];
  contradictions: IContradictionReport;
  openQuestions: readonly string[];
  generatedVsHandwritten: IGeneratedCodeReport;
  stableExperimentalDeprecated: IStabilityMap;
  taskContextHints: readonly ITaskContextHint[];
  recommendedSharkCraftFiles: readonly IRecommendedSharkCraftFile[];
  inferredPipelines: readonly IInferredPipeline[];
  inferredTemplates: readonly IInferredTemplateCandidate[];
  confidence: IRepositoryKnowledgeModelConfidence;
  limitations: readonly string[];
  generatedAt: string;
}

export interface IBuildRepositoryKnowledgeModelOptions {
  inspection: ISharkcraftInspection;
  depth?: IngestDepth;
  selectedSections?: readonly IngestSection[];
  excludedSections?: readonly IngestSection[];
  /** Pinned preset ids — order matters for ranking. */
  forcedPresetIds?: readonly string[];
  /** Free-form task description to bias ranking / hints. */
  task?: string;
  /** Whether to read large docs. Default true at depth >= Standard. */
  docsFirst?: boolean;
}

export async function buildRepositoryKnowledgeModel(
  options: IBuildRepositoryKnowledgeModelOptions,
): Promise<IRepositoryKnowledgeModel> {
  const inspection = options.inspection;
  const projectRoot = inspection.projectRoot;
  const depth = options.depth ?? IngestDepth.Standard;

  const requested = new Set<IngestSection>(
    options.selectedSections && options.selectedSections.length > 0
      ? options.selectedSections
      : ALL_INGEST_SECTIONS,
  );
  for (const ex of options.excludedSections ?? []) requested.delete(ex);
  const sectionsArr = ALL_INGEST_SECTIONS.filter((s) => requested.has(s));

  const limitations: string[] = [];

  // 1) Onboarding plan (existing) — gives us rules/paths/templates/boundaries/pipelines.
  let onboarding: IOnboardingPlan;
  try {
    onboarding = buildOnboardingPlan(inspection, {});
  } catch (err) {
    limitations.push(`onboarding plan build failed: ${(err as Error).message}`);
    onboarding = emptyOnboardingPlan(projectRoot);
  }

  // 2) Forced presets — slot them ahead of recommendations and mark transformational intent.
  const recRaw = recommendPresets(inspection.presetRegistry.list(), {
    profiles: inspection.workspace.profiles ?? [],
    limit: 20,
  });
  const transformationalIntents: string[] = [];
  const presets = applyForcedPresets(recRaw, options.forcedPresetIds ?? [], inspection, transformationalIntents);

  // 3) Architecture model.
  const areaMap = buildAreaMap(inspection);
  let importGraph: IImportGraphAnalysis | undefined;
  if (depth !== IngestDepth.Shallow) {
    try {
      importGraph = analyzeImportGraph(projectRoot);
    } catch (err) {
      limitations.push(`import graph analysis failed: ${(err as Error).message}`);
    }
  }
  const architectureModel = buildArchitectureModel(inspection, areaMap, importGraph);

  // 4) Business logic.
  let constructs: readonly IConstruct[] = listConstructs(inspection);
  if (constructs.length === 0) {
    try {
      constructs = await loadConstructs(inspection);
    } catch (err) {
      limitations.push(`construct load failed: ${(err as Error).message}`);
    }
  }
  const businessLogicModel = buildBusinessLogicModel(inspection, constructs, areaMap);

  // 5) Generated-code + stability + contradictions.
  // Depth-aware generated-code scan + annotation-aware stability map.
  let generatedDepth: GeneratedScanDepth = GeneratedScanDepth.Standard;
  if (depth === IngestDepth.Deep) generatedDepth = GeneratedScanDepth.Deep;
  if (depth === IngestDepth.Extreme) generatedDepth = GeneratedScanDepth.Extreme;
  const generatedReport = buildGeneratedCodeReport({ inspection, depth: generatedDepth });
  const scanAnnotations = depth === IngestDepth.Deep || depth === IngestDepth.Extreme;
  const annotationScanLimit = depth === IngestDepth.Extreme ? 5000 : 1500;
  const stabilityMap = buildStabilityMap({
    inspection,
    areaMap,
    importGraph,
    generatedRoots: generatedReport.generatedRoots.map((r) => r.path),
    scanAnnotations,
    annotationScanLimit,
  });
  const contradictions = buildContradictionReport({ inspection });

  // Language-aware sections. Detect language profiles once and reuse
  // the result everywhere it is needed; on shallow/standard depth only
  // profiles + commands are surfaced (cheap). Deep/extreme add the polyglot
  // dependency summary, boundary report, suggestions and test-impact.
  let languageProfiles: ILanguageProfileReport | undefined;
  let languageCommands: ILanguageCommandReport | undefined;
  let polyglotDependencySummary: IPolyglotDependencyGraph | undefined;
  let polyglotTestImpactSummary: IPolyglotTestImpact | undefined;
  let languageBoundarySuggestions: ILanguageBoundarySuggestionReport | undefined;
  let polyglotBoundaryReport: IPolyglotBoundaryReport | undefined;
  let languageRiskNotes: ILanguageRiskNote[] | undefined;
  let languageGeneratedCodeSignals: ILanguageGeneratedSignal[] | undefined;
  let languageStabilitySignals: ILanguageStabilitySignal[] | undefined;

  try {
    languageProfiles = detectLanguageProfiles(projectRoot);
    languageCommands = buildLanguageCommandReport(projectRoot, languageProfiles);

    // Polyglot risk notes — extracted from each profile.
    const polyglotLangs = languageProfiles.profiles.filter(
      (p) => p.language !== LanguageId.TypeScript && p.language !== LanguageId.JavaScript,
    );
    languageRiskNotes = [];
    for (const p of languageProfiles.profiles) {
      for (const note of p.riskNotes) {
        languageRiskNotes.push({ language: p.language, note });
      }
    }

    if (polyglotLangs.length > 0 && (depth === IngestDepth.Deep || depth === IngestDepth.Extreme)) {
      polyglotDependencySummary = scanPolyglotDependencies(projectRoot, {
        languages: polyglotLangs.map((p) => p.language),
      });
      try {
        polyglotBoundaryReport = buildPolyglotBoundaryReport({
          projectRoot,
          cached: languageProfiles,
          graph: polyglotDependencySummary,
        });
      } catch (err) {
        limitations.push(`polyglot boundary build failed: ${(err as Error).message}`);
      }
      try {
        languageBoundarySuggestions = suggestLanguageBoundaries(projectRoot);
      } catch (err) {
        limitations.push(`language boundary suggestions failed: ${(err as Error).message}`);
      }
      // Test impact uses an empty file list at the model build site — callers
      // pass concrete files via `shrk understand-task`. We still surface the
      // shape so downstream renderers know the language has impact data.
      try {
        polyglotTestImpactSummary = computePolyglotTestImpact(projectRoot, []);
      } catch (err) {
        limitations.push(`polyglot test impact failed: ${(err as Error).message}`);
      }
    }

    // Tag generated-code roots by language for the new section.
    languageGeneratedCodeSignals = [];
    for (const root of generatedReport.generatedRoots) {
      let lang = 'unknown';
      if (root.kind === 'java-generated') lang = LanguageId.Java;
      else if (root.kind === 'csharp-generated') lang = LanguageId.CSharp;
      else if (root.kind === 'python-generated') lang = LanguageId.Python;
      else if (root.kind === 'go-generated') lang = LanguageId.Go;
      else if (root.kind === 'rust-generated') lang = LanguageId.Rust;
      else if (root.kind === 'angular-environment' || root.kind === 'angular-router') lang = LanguageId.TypeScript;
      else if (root.kind === 'prisma-client') lang = LanguageId.TypeScript;
      else if (root.kind === 'openapi' || root.kind === 'graphql') lang = 'multi';
      if (lang !== 'unknown') {
        languageGeneratedCodeSignals.push({ language: lang, signal: root.reason, paths: [root.path] });
      }
    }

    // Tag stability areas by language guess (uses file-extension priors).
    languageStabilitySignals = [];
    for (const area of stabilityMap.areas) {
      const langs = new Set<string>();
      for (const f of inspection.sourceFiles) {
        if (!f.startsWith(area.path + '/') && f !== area.path) continue;
        const ext = nodePath.extname(f).toLowerCase();
        if (ext === '.ts' || ext === '.tsx') langs.add(LanguageId.TypeScript);
        else if (ext === '.js' || ext === '.jsx') langs.add(LanguageId.JavaScript);
        else if (ext === '.java') langs.add(LanguageId.Java);
        else if (ext === '.cs') langs.add(LanguageId.CSharp);
        else if (ext === '.py') langs.add(LanguageId.Python);
        else if (ext === '.go') langs.add(LanguageId.Go);
        else if (ext === '.rs') langs.add(LanguageId.Rust);
      }
      for (const l of langs) {
        languageStabilitySignals.push({ language: l, kind: area.kind, paths: [area.path] });
      }
    }
  } catch (err) {
    limitations.push(`language profiling failed: ${(err as Error).message}`);
  }

  // 6) Risk areas — high-fan-in or explicitly risky paths.
  const riskAreas = buildRiskAreas(inspection, stabilityMap, importGraph);

  // 7) Domain map.
  const domainMap: IDomainMap = {
    areas: areaMap.areas.map((a) => ({
      id: a.id,
      paths: a.paths,
      kind: a.kind,
      fileCount: a.fileCount,
    })),
    constructs: constructs.map((c) => ({
      id: c.id,
      title: c.title,
      paths: deriveConstructPaths(c),
    })),
  };

  // 8) Workflow map — pulled from package scripts + pipelines + docs hints.
  const workflowMap = buildWorkflowMap(inspection, onboarding);

  // 9) Change protocol — built from rules + boundary fixes + safe-codegen.
  const changeProtocol = buildChangeProtocol(inspection, onboarding);

  // 10) Task context hints + open questions.
  const taskContextHints = buildTaskContextHints(inspection, onboarding, generatedReport, contradictions, stabilityMap, options.task);
  const openQuestions = buildOpenQuestions(onboarding, contradictions, generatedReport, stabilityMap);

  // 11) Recommended SharkCraft files.
  const recommendedSharkCraftFiles = buildRecommendedFiles({
    onboarding,
    generatedReport,
    stabilityMap,
    contradictions,
    businessLogicModel,
    domainMap,
  });

  // 12) Confidence.
  const confidence = computeConfidence({
    inspection,
    onboarding,
    generatedReport,
    contradictions,
    stabilityMap,
    importGraph,
    docsScanned: contradictions.filesScanned,
  });

  // 13) Repository overview.
  const repositoryOverview: IRepositoryOverview = {
    projectName: inspection.workspace.packageName ?? 'unknown-project',
    ...(inspection.workspace.description ? { description: inspection.workspace.description } : {}),
    packageManager: inspection.workspace.packageManager.manager,
    frameworks: inspection.workspace.frameworks.map((f) => f.name),
    topLevelDirs: inspection.workspace.topLevelDirs,
    knownScripts: Object.keys(inspection.workspace.scripts ?? {}),
    hasSharkcraftFolder: inspection.hasSharkcraftFolder,
    monorepo: detectMonorepo(inspection),
    detectedLanguages: detectLanguages(inspection),
  };

  return {
    schema: REPOSITORY_KNOWLEDGE_MODEL_SCHEMA,
    projectRoot,
    depth,
    presets,
    forcedPresetIds: options.forcedPresetIds ?? [],
    transformationalIntents,
    selectedSections: sectionsArr,
    repositoryOverview,
    ...(languageProfiles ? { languageProfiles } : {}),
    ...(languageCommands ? { languageCommands } : {}),
    ...(polyglotDependencySummary ? { polyglotDependencySummary } : {}),
    ...(polyglotTestImpactSummary ? { polyglotTestImpactSummary } : {}),
    ...(languageBoundarySuggestions ? { languageBoundarySuggestions } : {}),
    ...(polyglotBoundaryReport ? { polyglotBoundaryReport } : {}),
    ...(languageRiskNotes ? { languageRiskNotes } : {}),
    ...(languageGeneratedCodeSignals ? { languageGeneratedCodeSignals } : {}),
    ...(languageStabilitySignals ? { languageStabilitySignals } : {}),
    architectureModel,
    businessLogicModel,
    rulesAndConventions: {
      rules: onboarding.inferredRules,
      paths: onboarding.inferredPathConventions,
      verificationCommands: onboarding.inferredVerificationCommands,
    },
    dependencyBoundaries: {
      rules: onboarding.inferredBoundaryRules,
      importGraphSummary: {
        nodeCount: importGraph?.filesScanned ?? 0,
        edgeCount: importGraph?.packageCount ?? 0,
        cycles: (importGraph?.cycles ?? []).map((c) => c.nodes.join(' → ')),
      },
    },
    domainMap,
    workflowMap,
    changeProtocol,
    riskAreas,
    contradictions,
    openQuestions,
    generatedVsHandwritten: generatedReport,
    stableExperimentalDeprecated: stabilityMap,
    taskContextHints,
    recommendedSharkCraftFiles,
    inferredPipelines: onboarding.inferredPipelines,
    inferredTemplates: onboarding.inferredTemplateCandidates,
    confidence,
    limitations,
    generatedAt: new Date().toISOString(),
  };
}

function emptyOnboardingPlan(projectRoot: string): IOnboardingPlan {
  return {
    projectSummary: {
      projectRoot,
      packageManager: PackageManager.Unknown,
      profiles: [],
      hasSharkcraftFolder: false,
    },
    recommendedPresets: [],
    suggestedFiles: [],
    inferredPathConventions: [],
    inferredVerificationCommands: [],
    inferredBoundaryRules: [],
    inferredTemplateCandidates: [],
    inferredRules: [],
    inferredPipelines: [],
    detectedInstructionFiles: [],
    risks: [],
    nextCommands: [],
    readiness: {
      current: 'poor',
      expected: 'poor',
      currentScore: 0,
      expectedScore: 0,
      topImprovements: [],
    },
    monorepoSummary: null,
  };
}

function applyForcedPresets(
  raw: readonly IPresetRecommendation[],
  forced: readonly string[],
  inspection: ISharkcraftInspection,
  transformationalIntents: string[],
): readonly IPresetRecommendation[] {
  if (forced.length === 0) return raw;
  const workspaceProfiles = new Set(inspection.workspace.profiles ?? []);
  const byId = new Map(raw.map((r) => [r.preset.id, r] as const));
  const out: IPresetRecommendation[] = [];
  for (const id of forced) {
    const found = byId.get(id);
    if (found) {
      out.push(found);
      byId.delete(id);
      // Even if the preset appears in the recommendation list, treat it as
      // transformational intent when its `appliesTo` profiles do not overlap
      // with the workspace's detected profiles.
      const requirements = found.preset.appliesTo ?? [];
      const matches = requirements.filter((p) => workspaceProfiles.has(p));
      if (requirements.length > 0 && matches.length === 0) {
        transformationalIntents.push(`forced preset "${id}" does not match repo profile yet — treat as adaptation guidance`);
      }
      continue;
    }
    const preset = inspection.presetRegistry.get(id);
    if (preset) {
      out.push({
        preset,
        score: 0,
        confidence: 'low',
        reasons: ['Forced preset — repo signals do not match yet (transformational intent).'],
      });
      transformationalIntents.push(`forced preset "${id}" does not match repo profile yet — treat as adaptation guidance`);
    } else {
      transformationalIntents.push(`unknown forced preset "${id}" — ignored`);
    }
  }
  for (const remaining of byId.values()) out.push(remaining);
  return out;
}

function buildArchitectureModel(
  inspection: ISharkcraftInspection,
  areaMap: IAreaMap,
  importGraph: IImportGraphAnalysis | undefined,
): IArchitectureModel {
  const layers: IArchitectureLayerSummary[] = areaMap.areas.map((a) => ({
    id: a.id,
    description: `Area "${a.id}" detected from ${a.paths.length} path(s).`,
    paths: a.paths,
    fileCount: a.fileCount,
  }));

  const publicApis = inspection.sourceFiles
    .filter((f) => /(^|\/)src\/index\.(ts|tsx|js)$/.test(f) || /(^|\/)packages\/[^\/]+\/src\/index\.(ts|tsx)$/.test(f))
    .map((f) => nodePath.dirname(f));

  const notes: string[] = [];
  if (importGraph && importGraph.cycles.length > 0) {
    notes.push(`${importGraph.cycles.length} import cycle(s) detected; review before layering changes.`);
  }
  return { layers, publicApis, notes };
}

function buildBusinessLogicModel(
  inspection: ISharkcraftInspection,
  constructs: readonly IConstruct[],
  _areaMap: IAreaMap,
): IBusinessLogicModel {
  const entities: IBusinessConcept[] = constructs
    .filter((c) => /entity|model|domain|value-object|record/i.test(c.type) || hasFacetKindLike(c, /entity|model|domain/))
    .map((c) => ({
      id: c.id,
      title: c.title,
      source: 'construct',
      summary: c.description ?? c.title,
      paths: deriveConstructPaths(c),
      relatedWorkflows: [],
    }));

  const workflows: IBusinessConcept[] = constructs
    .filter((c) => /workflow|service|pipeline|playbook|use-?case|saga|flow/i.test(c.type) || hasFacetKindLike(c, /workflow|service|pipeline|playbook|usecase/))
    .map((c) => ({
      id: c.id,
      title: c.title,
      source: 'construct',
      summary: c.description ?? c.title,
      paths: deriveConstructPaths(c),
      relatedWorkflows: [],
    }));

  const invariants: string[] = [];
  // Infer some invariants from package.json + frameworks.
  if (inspection.workspace.frameworks.some((f) => /angular/i.test(f.name))) {
    invariants.push('Components/services follow Angular DI — do not instantiate services directly outside the injector.');
  }
  if (inspection.workspace.hasTypeScript) {
    invariants.push('TypeScript strict mode is the contract — no any in public surfaces.');
  }
  if (inspection.workspace.frameworks.some((f) => /nx/i.test(f.name))) {
    invariants.push('Nx project boundaries are enforced — verify tags/scope before adding cross-project imports.');
  }
  return { entities, workflows, invariants };
}

function buildWorkflowMap(
  inspection: ISharkcraftInspection,
  onboarding: IOnboardingPlan,
): IWorkflowMap {
  const workflows: IWorkflowEntry[] = [];
  // Package scripts.
  for (const [name, cmd] of Object.entries(inspection.workspace.scripts ?? {})) {
    workflows.push({
      id: `script:${name}`,
      title: name,
      source: 'scripts',
      steps: [cmd as string],
    });
  }
  // Inferred pipelines.
  for (const p of onboarding.inferredPipelines) {
    workflows.push({
      id: `pipeline:${p.id}`,
      title: p.title,
      source: 'inferred',
      steps: p.steps,
    });
  }
  return { workflows };
}

function buildChangeProtocol(
  inspection: ISharkcraftInspection,
  onboarding: IOnboardingPlan,
): IChangeProtocol {
  const entries: IChangeProtocolEntry[] = [];

  entries.push({
    id: 'change-protocol.feature',
    title: 'Add a feature',
    steps: [
      'Read relevant rules + path conventions (`shrk context --task "<task>"`).',
      'If a template exists for the construct, run `shrk gen <id> <name> --dry-run --save-plan`.',
      'Review the plan (`shrk plan review`).',
      'Apply with `shrk apply <plan> --verify-signature --validate`.',
      'Run verification commands listed in the task packet.',
    ],
    recommendedCommands: ['shrk task', 'shrk gen', 'shrk plan review', 'shrk apply'],
  });

  entries.push({
    id: 'change-protocol.refactor',
    title: 'Refactor existing code',
    steps: [
      'Map impact via `shrk impact <path>`.',
      'Check boundaries with `shrk check boundaries`.',
      'Plan + dry-run, then apply.',
      'Re-run tests + boundary check after.',
    ],
    recommendedCommands: ['shrk impact', 'shrk check boundaries', 'shrk gen', 'shrk apply'],
  });

  entries.push({
    id: 'change-protocol.public-api',
    title: 'Change a public API',
    steps: [
      'Verify export barrels (`packages/*/src/index.ts`).',
      'Look up consumers via `shrk api report` and `shrk impact`.',
      'Document the change in a decision record (`shrk decisions new`).',
      'Run release-readiness + boundary checks.',
    ],
    recommendedCommands: ['shrk api report', 'shrk impact', 'shrk decisions new', 'shrk release readiness'],
  });

  if (inspection.workspace.frameworks.some((f) => /angular/i.test(f.name))) {
    entries.push({
      id: 'change-protocol.angular-component',
      title: 'Add an Angular component / directive / service',
      steps: [
        'Run `shrk context --task "add angular <kind>"` to pick up Modern Angular rules.',
        'Use signals or RxJS deliberately — do not mirror them.',
        'Avoid deep imports across libraries.',
        'Add tests under the same library; respect Nx tags / boundaries.',
      ],
      recommendedCommands: ['shrk context', 'shrk gen', 'shrk check boundaries'],
    });
  }

  void onboarding;
  return { entries };
}

function buildTaskContextHints(
  inspection: ISharkcraftInspection,
  _onboarding: IOnboardingPlan,
  generatedReport: IGeneratedCodeReport,
  contradictions: IContradictionReport,
  stabilityMap: IStabilityMap,
  task: string | undefined,
): readonly ITaskContextHint[] {
  const hints: ITaskContextHint[] = [];
  hints.push({
    trigger: 'before any task',
    hint: 'Run `shrk understand-task "<task>"` to load relevant rules, paths, risks and recommended commands.',
    recommendedCommand: 'shrk understand-task "<task>"',
  });
  hints.push({
    trigger: 'when changing files',
    hint: 'Run `shrk validate-change --staged` to detect missing tests, broken boundaries, and policy gates before submitting.',
    recommendedCommand: 'shrk validate-change --staged',
  });
  if (generatedReport.generatedRoots.length > 0) {
    hints.push({
      trigger: 'when a task touches a generated root',
      hint: `Generated roots detected (${generatedReport.generatedRoots.length}). Edit generator inputs, not the generated output.`,
      recommendedCommand: 'shrk generated report',
    });
  }
  if (stabilityMap.byKind[StabilityKind.Deprecated].length > 0 || stabilityMap.byKind[StabilityKind.Legacy].length > 0) {
    hints.push({
      trigger: 'when a task lands in deprecated/legacy areas',
      hint: 'Deprecated or legacy areas exist — prefer the stable replacement when adding new code.',
      recommendedCommand: 'shrk stability map',
    });
  }
  if (contradictions.findings.length > 0) {
    hints.push({
      trigger: 'when documentation seems wrong',
      hint: `${contradictions.findings.length} doc/code contradictions detected. Verify the doc before trusting it.`,
      recommendedCommand: 'shrk contradictions',
    });
  }
  if (task && /angular/i.test(task)) {
    hints.push({
      trigger: 'angular work',
      hint: 'Use Modern Angular preset rules (signals/RxJS discipline, standalone components, OnPush).',
      recommendedCommand: 'shrk presets get modern-angular',
    });
  }
  if (inspection.workspace.hasTypeScript) {
    hints.push({
      trigger: 'before public API changes',
      hint: 'Strict TypeScript: avoid any/unsafe assertions; prefer satisfies and discriminated unions.',
      recommendedCommand: 'shrk presets get strict-typescript',
    });
  }
  return hints;
}

function buildOpenQuestions(
  onboarding: IOnboardingPlan,
  contradictions: IContradictionReport,
  generatedReport: IGeneratedCodeReport,
  stabilityMap: IStabilityMap,
): readonly string[] {
  const questions: string[] = [];
  for (const r of onboarding.risks) questions.push(`Onboarding risk — ${r}`);
  if (contradictions.findings.length > 0) {
    questions.push(`Resolve ${contradictions.findings.length} doc/code contradictions before relying on docs as authoritative.`);
  }
  if (generatedReport.generatedRoots.length === 0) {
    questions.push('No generated roots were detected — is everything truly hand-written, or are markers missing?');
  }
  if (stabilityMap.byKind[StabilityKind.HighRisk].length > 0) {
    questions.push(`${stabilityMap.byKind[StabilityKind.HighRisk].length} high-fan-in areas — confirm they are intentional.`);
  }
  return questions;
}

function buildRiskAreas(
  inspection: ISharkcraftInspection,
  stabilityMap: IStabilityMap,
  importGraph: IImportGraphAnalysis | undefined,
): readonly IRiskAreaEntry[] {
  const out: IRiskAreaEntry[] = [];
  for (const area of stabilityMap.byKind[StabilityKind.HighRisk]) {
    out.push({
      id: `high-fan-in:${area.path}`,
      path: area.path,
      reason: area.note ?? 'High fan-in detected.',
      recommendation: 'Add an explicit boundary or split the area before further large changes.',
      score: 80,
    });
  }
  for (const area of stabilityMap.byKind[StabilityKind.Deprecated]) {
    out.push({
      id: `deprecated:${area.path}`,
      path: area.path,
      reason: 'Folder marked deprecated.',
      recommendation: 'Migrate consumers off and remove after deprecation window.',
      score: 60,
    });
  }
  void inspection;
  void importGraph;
  return out;
}

function deriveConstructPaths(c: IConstruct): readonly string[] {
  const paths: string[] = [];
  for (const file of c.files ?? []) paths.push(file);
  for (const api of c.publicApi ?? []) paths.push(api);
  for (const list of Object.values(c.facets ?? {})) {
    for (const v of list) {
      if (v.source && /[\\/.]/.test(v.source)) paths.push(v.source);
    }
  }
  return Array.from(new Set(paths));
}

function hasFacetKindLike(c: IConstruct, re: RegExp): boolean {
  for (const kind of Object.keys(c.facets ?? {})) {
    if (re.test(kind)) return true;
  }
  return false;
}

function detectMonorepo(inspection: ISharkcraftInspection): boolean {
  if (inspection.workspace.frameworks.some((f) => /nx|rush|lerna|turborepo|moon/i.test(f.name))) return true;
  if (inspection.workspace.topLevelDirs.includes('packages') && inspection.workspace.topLevelDirs.includes('apps')) return true;
  if (inspection.workspace.topLevelDirs.includes('packages')) return true;
  return false;
}

function detectLanguages(inspection: ISharkcraftInspection): readonly string[] {
  const langs = new Set<string>();
  if (inspection.workspace.hasTypeScript) langs.add('typescript');
  for (const f of inspection.sourceFiles) {
    const ext = nodePath.extname(f).toLowerCase();
    if (ext === '.ts' || ext === '.tsx') langs.add('typescript');
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') langs.add('javascript');
    if (ext === '.py') langs.add('python');
    if (ext === '.go') langs.add('go');
    if (ext === '.rs') langs.add('rust');
    if (ext === '.java') langs.add('java');
    if (ext === '.kt') langs.add('kotlin');
    if (ext === '.cs') langs.add('csharp');
    if (ext === '.proto') langs.add('protobuf');
    if (ext === '.graphql' || ext === '.gql') langs.add('graphql');
  }
  return Array.from(langs).sort();
}

interface IRecommendedFileInput {
  onboarding: IOnboardingPlan;
  generatedReport: IGeneratedCodeReport;
  stabilityMap: IStabilityMap;
  contradictions: IContradictionReport;
  businessLogicModel: IBusinessLogicModel;
  domainMap: IDomainMap;
}

function buildRecommendedFiles(input: IRecommendedFileInput): readonly IRecommendedSharkCraftFile[] {
  const files: IRecommendedSharkCraftFile[] = [];

  files.push({
    target: 'sharkcraft/knowledge.ts',
    reason: 'Capture architecture/domain concepts and invariants surfaced by ingest.',
    entries: [
      ...input.businessLogicModel.entities.map((e) => ({
        id: `concept.${e.id}`,
        kind: 'knowledge-entry',
        reason: `Domain entity surfaced from construct registry (${e.paths.length} path(s)).`,
      })),
      ...input.businessLogicModel.workflows.map((w) => ({
        id: `workflow.${w.id}`,
        kind: 'knowledge-entry',
        reason: 'Workflow surfaced from construct registry.',
      })),
      ...input.businessLogicModel.invariants.map((inv, i) => ({
        id: `invariant.${i}`,
        kind: 'knowledge-entry',
        reason: inv,
      })),
    ],
  });

  files.push({
    target: 'sharkcraft/rules.ts',
    reason: 'Persist inferred rules + preset-contributed rules as live SharkCraft rules.',
    entries: input.onboarding.inferredRules.map((r) => ({
      id: r.id,
      kind: 'rule',
      reason: r.reason,
    })),
  });

  files.push({
    target: 'sharkcraft/paths.ts',
    reason: 'Persist inferred path conventions so the engine ranks correctly.',
    entries: input.onboarding.inferredPathConventions.map((p) => ({
      id: p.id,
      kind: 'path',
      reason: p.reason,
    })),
  });

  files.push({
    target: 'sharkcraft/boundaries.ts',
    reason: 'Enforce dependency layers and forbid framework leaks.',
    entries: input.onboarding.inferredBoundaryRules.map((b) => ({
      id: b.id,
      kind: 'boundary',
      reason: b.reason,
    })),
  });

  files.push({
    target: 'sharkcraft/constructs.ts',
    reason: 'Make discovered constructs first-class so templates/playbooks can reference them.',
    entries: input.domainMap.constructs.map((c) => ({
      id: c.id,
      kind: 'construct',
      reason: 'Construct discovered from source.',
    })),
  });

  const policies: IDraftEntryRef[] = [];
  if (input.generatedReport.recommendedPolicyRules.length > 0) {
    for (const p of input.generatedReport.recommendedPolicyRules) {
      policies.push({
        id: p.suggestedId,
        kind: 'policy',
        reason: p.reason,
      });
    }
  }
  if (input.stabilityMap.byKind[StabilityKind.Deprecated].length > 0) {
    policies.push({
      id: 'policy.deprecated-readonly',
      kind: 'policy',
      reason: 'Deprecated areas should require explicit migration intent before being modified.',
    });
  }
  files.push({
    target: 'sharkcraft/policies.ts',
    reason: 'Governance gates inferred from generated-code and stability signals.',
    entries: policies,
  });

  files.push({
    target: 'sharkcraft/playbooks.ts',
    reason: 'Common development workflows (add feature / refactor / public-API change).',
    entries: [
      { id: 'add-feature', kind: 'playbook', reason: 'Standard add-feature flow.' },
      { id: 'refactor', kind: 'playbook', reason: 'Refactor with impact + boundary checks.' },
      { id: 'public-api-change', kind: 'playbook', reason: 'Gated public-API change flow.' },
    ],
  });

  files.push({
    target: 'sharkcraft/templates.ts',
    reason: 'Safe, scaffold-pattern-backed templates inferred from siblings.',
    entries: input.onboarding.inferredTemplateCandidates
      .filter((t) => t.confidence !== 'low')
      .map((t) => ({
        id: t.id,
        kind: 'template',
        reason: t.reason,
      })),
  });

  files.push({
    target: 'sharkcraft/pipelines.ts',
    reason: 'Inferred pipelines (context-only / feature-dev / unit-test / safe-refactor).',
    entries: input.onboarding.inferredPipelines.map((p) => ({
      id: p.id,
      kind: 'pipeline',
      reason: p.reason,
    })),
  });

  files.push({
    target: 'sharkcraft/presets.ts',
    reason: 'Local preset bundle binding the chosen baseline presets.',
    entries: [
      { id: 'local.bundle', kind: 'preset', reason: 'Local preset bundle for this repo.' },
    ],
  });

  return files;
}

interface IConfidenceInput {
  inspection: ISharkcraftInspection;
  onboarding: IOnboardingPlan;
  generatedReport: IGeneratedCodeReport;
  contradictions: IContradictionReport;
  stabilityMap: IStabilityMap;
  importGraph: IImportGraphAnalysis | undefined;
  docsScanned: number;
}

function computeConfidence(input: IConfidenceInput): IRepositoryKnowledgeModelConfidence {
  const notes: string[] = [];
  const perSection: Record<IngestSection, number> = {
    [IngestSection.RepositoryOverview]: 90,
    [IngestSection.ArchitectureModel]: input.importGraph ? 80 : 55,
    [IngestSection.BusinessLogicModel]: input.inspection.sourceFiles.length > 0 ? 50 : 20,
    [IngestSection.RulesAndConventions]: input.onboarding.inferredRules.length > 0 ? 75 : 30,
    [IngestSection.DependencyBoundaries]: input.onboarding.inferredBoundaryRules.length > 0 ? 70 : 35,
    [IngestSection.DomainMap]: 60,
    [IngestSection.WorkflowMap]: 70,
    [IngestSection.ChangeProtocol]: 80,
    [IngestSection.RiskAreas]: input.stabilityMap.areas.length > 0 ? 65 : 30,
    [IngestSection.Contradictions]: input.docsScanned > 0 ? 70 : 30,
    [IngestSection.OpenQuestions]: 85,
    [IngestSection.GeneratedVsHandwritten]: input.generatedReport.filesScanned > 0 ? 80 : 40,
    [IngestSection.StableExperimentalDeprecated]: input.stabilityMap.areas.length > 0 ? 75 : 40,
    [IngestSection.TaskContextHints]: 80,
    [IngestSection.RecommendedSharkCraftFiles]: 85,
  };
  const values = Object.values(perSection);
  const overall = Math.round(values.reduce((a, b) => a + b, 0) / values.length);

  if (!input.importGraph) notes.push('Import graph unavailable — architecture/risk numbers are heuristic only.');
  if (input.docsScanned === 0) notes.push('No docs scanned — contradiction detection is conservative.');
  if (input.inspection.sourceFiles.length === 0) notes.push('No source files visible — many sections fall back to onboarding inference only.');

  return { overall, perSection, notes };
}

export function renderRepositoryKnowledgeModelText(model: IRepositoryKnowledgeModel): string {
  const lines: string[] = [];
  lines.push('=== Repository knowledge model ===');
  lines.push(`  project       ${model.repositoryOverview.projectName}`);
  lines.push(`  depth         ${model.depth}`);
  lines.push(`  presets       ${model.presets.slice(0, 6).map((p) => p.preset.id).join(', ') || '(none)'}`);
  if (model.transformationalIntents.length > 0) {
    lines.push('');
    lines.push('Transformational intents:');
    for (const t of model.transformationalIntents) lines.push(`  - ${t}`);
  }
  lines.push('');
  lines.push('Sections:');
  for (const s of model.selectedSections) lines.push(`  • ${s}  (confidence ${model.confidence.perSection[s] ?? '-'})`);
  lines.push('');
  lines.push(`Risk areas: ${model.riskAreas.length}`);
  lines.push(`Contradictions: ${model.contradictions.findings.length}`);
  lines.push(`Generated roots: ${model.generatedVsHandwritten.generatedRoots.length}`);
  lines.push(`Stability areas: ${model.stableExperimentalDeprecated.areas.length}`);
  lines.push(`Open questions: ${model.openQuestions.length}`);
  lines.push(`Confidence: ${model.confidence.overall}/100`);
  if (model.languageProfiles && model.languageProfiles.profiles.length > 0) {
    lines.push('');
    lines.push(`Languages: ${model.languageProfiles.profiles.map((p) => `${p.language}(${p.fileCount})`).join(', ')}`);
    if (model.polyglotBoundaryReport) {
      lines.push(`Polyglot boundary violations: ${model.polyglotBoundaryReport.counts.violations} (errors=${model.polyglotBoundaryReport.counts.errors})`);
    }
  }
  if (model.limitations.length > 0) {
    lines.push('');
    lines.push('Limitations:');
    for (const l of model.limitations) lines.push(`  - ${l}`);
  }
  return lines.join('\n');
}

export function renderRepositoryKnowledgeModelMarkdown(model: IRepositoryKnowledgeModel): string {
  const lines: string[] = [];
  lines.push(`# Repository knowledge model — ${model.repositoryOverview.projectName}`);
  lines.push('');
  lines.push(`- Depth: **${model.depth}**`);
  lines.push(`- Generated at: ${model.generatedAt}`);
  lines.push(`- Confidence: **${model.confidence.overall}/100**`);
  if (model.transformationalIntents.length > 0) {
    lines.push('');
    lines.push('> Transformational intents:');
    for (const t of model.transformationalIntents) lines.push(`> - ${t}`);
  }
  lines.push('');
  lines.push('## Selected sections');
  lines.push('');
  for (const s of model.selectedSections) {
    lines.push(`- **${s}** — confidence ${model.confidence.perSection[s] ?? '-'}`);
  }
  lines.push('');
  lines.push('## Risk areas');
  lines.push('');
  if (model.riskAreas.length === 0) {
    lines.push('_None._');
  } else {
    lines.push('| Path | Reason | Score |');
    lines.push('|---|---|---|');
    for (const r of model.riskAreas) lines.push(`| \`${r.path}\` | ${r.reason} | ${r.score} |`);
  }
  lines.push('');
  lines.push('## Recommended SharkCraft files');
  lines.push('');
  for (const f of model.recommendedSharkCraftFiles) {
    lines.push(`### ${f.target}`);
    lines.push('');
    lines.push(f.reason);
    lines.push('');
    if (f.entries.length === 0) {
      lines.push('_no entries_');
    } else {
      lines.push('| Entry | Kind | Why this goes here |');
      lines.push('|---|---|---|');
      for (const e of f.entries) lines.push(`| \`${e.id}\` | ${e.kind} | ${e.reason} |`);
    }
    lines.push('');
  }
  if (model.languageProfiles && model.languageProfiles.profiles.length > 0) {
    lines.push('## Languages');
    lines.push('');
    lines.push('| Language | Files | Confidence | Build | Test framework(s) |');
    lines.push('|---|---|---|---|---|');
    for (const p of model.languageProfiles.profiles) {
      lines.push(`| \`${p.language}\` | ${p.fileCount} | ${p.confidence} | ${p.buildTool ?? '-'} | ${p.testFrameworks.join(', ') || '-'} |`);
    }
    lines.push('');
  }
  if (model.polyglotBoundaryReport && model.polyglotBoundaryReport.counts.violations > 0) {
    lines.push('## Polyglot boundary violations');
    lines.push('');
    lines.push('| Severity | Rule | From | Import |');
    lines.push('|---|---|---|---|');
    for (const v of model.polyglotBoundaryReport.violations.slice(0, 30)) {
      lines.push(`| ${v.severity} | \`${v.ruleId}\` | \`${v.fromFile}\` | \`${v.importSpecifier}\` |`);
    }
    lines.push('');
  }
  if (model.openQuestions.length > 0) {
    lines.push('## Open questions');
    lines.push('');
    for (const q of model.openQuestions) lines.push(`- ${q}`);
  }
  if (model.limitations.length > 0) {
    lines.push('');
    lines.push('## Limitations');
    lines.push('');
    for (const l of model.limitations) lines.push(`- ${l}`);
  }
  return lines.join('\n');
}

export function renderRepositoryKnowledgeModelJson(model: IRepositoryKnowledgeModel): string {
  return JSON.stringify(model, null, 2);
}

export function renderRepositoryKnowledgeModelHtml(model: IRepositoryKnowledgeModel): string {
  const md = renderRepositoryKnowledgeModelMarkdown(model);
  const body = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Repository knowledge model</title><style>body{font-family:system-ui;max-width:960px;margin:32px auto;padding:0 16px}pre{white-space:pre-wrap}</style></head><body><pre>${body}</pre></body></html>`;
}
