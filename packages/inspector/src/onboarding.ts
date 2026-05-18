import { existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  PackageManager,
  WorkspaceProfile,
  findFiles,
  type IWorkspaceSummary,
} from '@shrkcrft/workspace';
import {
  recommendPresets,
  type IPreset,
  type IPresetRecommendation,
} from '@shrkcrft/presets';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import {
  buildAiReadinessReport,
  type ReadinessGrade,
} from './ai-readiness.ts';
import {
  inferTemplateBody,
  type IInferredTemplateScaffold,
} from './template-body-inference.ts';
import {
  buildMonorepoSummary,
  type IMonorepoSummary,
} from './monorepo-onboarding.ts';

// ─── Public types ────────────────────────────────────────────────────────────

export interface IInferredPathConvention {
  id: string;
  title: string;
  content: string;
  /** Glob patterns matching files this convention applies to. */
  patterns: readonly string[];
  reason: string;
}

export interface IInferredVerificationCommand {
  id: string;
  label: string;
  command: string;
  trusted: boolean;
  reason: string;
}

export interface IInferredBoundaryRule {
  id: string;
  title: string;
  severity: 'error' | 'warning';
  from: readonly string[];
  forbiddenImports?: readonly string[];
  allowedImports?: readonly string[];
  suggestedFix: string;
  reason: string;
}

export interface IInferredTemplateCandidate {
  id: string;
  name: string;
  description: string;
  /** Sample file we'd model the template on (if any). */
  sample?: string;
  /** Suggested targetPath pattern relative to projectRoot. */
  targetPathHint?: string;
  /** Whether we are confident enough to emit a draft. */
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  /**
   * Runnable scaffold body — only populated when the caller passed
   * `scaffoldTemplates: true` AND scaffolding succeeded for this candidate.
   * Drafts use this to emit a runnable template body; absence means the user
   * gets the conservative metadata-only entry.
   */
  scaffold?: IInferredTemplateScaffold;
}

export interface IInferredRule {
  id: string;
  title: string;
  content: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  source:
    | 'package-json'
    | 'tsconfig'
    | 'folder-structure'
    | 'imports'
    | 'agents-md';
  reason: string;
}

export interface IInferredPipeline {
  id: string;
  title: string;
  description: string;
  /** Suggested step ids in order. */
  steps: readonly string[];
  reason: string;
}

export interface IDetectedInstructionFile {
  kind: 'agents-md' | 'claude-md' | 'cursor-rules';
  /** Project-relative path. */
  path: string;
  /** The CLI command we'd recommend running. */
  importCommand: string;
}

export interface IReadinessEstimate {
  current: ReadinessGrade;
  expected: ReadinessGrade;
  currentScore: number;
  expectedScore: number;
  topImprovements: readonly string[];
}

export interface IOnboardingProjectSummary {
  projectRoot: string;
  projectName?: string;
  description?: string;
  packageManager: PackageManager;
  profiles: readonly WorkspaceProfile[];
  hasSharkcraftFolder: boolean;
}

export interface IOnboardingPlan {
  projectSummary: IOnboardingProjectSummary;
  /** Best-fit presets ranked against detected profiles. */
  recommendedPresets: readonly IPresetRecommendation[];
  /** Suggested sharkcraft/* files to scaffold. */
  suggestedFiles: readonly string[];
  inferredPathConventions: readonly IInferredPathConvention[];
  inferredVerificationCommands: readonly IInferredVerificationCommand[];
  inferredBoundaryRules: readonly IInferredBoundaryRule[];
  inferredTemplateCandidates: readonly IInferredTemplateCandidate[];
  inferredRules: readonly IInferredRule[];
  inferredPipelines: readonly IInferredPipeline[];
  /** AGENTS.md / CLAUDE.md / .cursor/rules detected for optional import. */
  detectedInstructionFiles: readonly IDetectedInstructionFile[];
  /** Risks/warnings — things we couldn't infer or need human review. */
  risks: readonly string[];
  /** Suggested commands the user can run next. */
  nextCommands: readonly string[];
  readiness: IReadinessEstimate;
  /**
   * Monorepo overview when the project has workspaces / Nx / packages+libs+apps.
   * `null` for plain single-package repos.
   */
  monorepoSummary: IMonorepoSummary | null;
}

export interface IBuildOnboardingPlanOptions {
  /** Pinned preset id to surface first in the recommendation list. */
  preferredPreset?: string;
  /**
   * When true, attempt to produce runnable scaffolded bodies for high- and
   * medium-confidence template candidates. Default false (metadata only).
   */
  scaffoldTemplates?: boolean;
}

// ─── Top-level orchestrator ───────────────────────────────────────────────────

export function buildOnboardingPlan(
  inspection: ISharkcraftInspection,
  options: IBuildOnboardingPlanOptions = {},
): IOnboardingPlan {
  const ws = inspection.workspace;
  const subDirs = listSubDirs(ws.projectRoot);

  const inferredPathConventions = inferPathConventions(ws, subDirs);
  const inferredVerificationCommands = inferVerificationCommands(ws);
  const inferredBoundaryRules = inferBoundaryRules(ws, subDirs);
  const inferredTemplateCandidates = inferTemplateCandidates(ws, {
    scaffoldTemplates: options.scaffoldTemplates === true,
  });
  const inferredRules = inferRules(ws);
  const inferredPipelines = inferPipelines(ws, inferredVerificationCommands);
  const detectedInstructionFiles = detectInstructionFiles(ws.projectRoot);
  const monorepoSummary = buildMonorepoSummary(ws, subDirs);

  // RecommendPresets now applies a miss penalty (-3 per missing
  // appliesTo profile), so a preferred preset that previously ranked just
  // inside the top 5 can drop out on minor profile changes. Use a wider
  // window when a preferredPreset is set so the reorder helper always has
  // something to pin.
  const presetRecs = recommendPresets(inspection.presetRegistry.list(), {
    profiles: ws.profiles,
    limit: options.preferredPreset ? 20 : 5,
  });
  const recommendedPresets = options.preferredPreset
    ? reorderForPreferredPreset(
        presetRecs,
        options.preferredPreset,
        inspection.presetRegistry,
      )
    : presetRecs;

  const suggestedFiles = buildSuggestedFiles(ws);
  const risks = collectRisks(ws, inferredTemplateCandidates);
  const readiness = estimateReadinessImpact(
    inspection,
    inferredPathConventions,
    inferredRules,
    inferredPipelines,
    inferredVerificationCommands,
    inferredBoundaryRules,
  );

  const nextCommands = buildNextCommands(ws.hasSharkcraftFolder, {
    scaffoldTemplates: options.scaffoldTemplates === true,
    isMonorepo: !!monorepoSummary,
  });

  return {
    projectSummary: {
      projectRoot: ws.projectRoot,
      ...(ws.packageName ? { projectName: ws.packageName } : {}),
      ...(ws.description ? { description: ws.description } : {}),
      packageManager: ws.packageManager.manager,
      profiles: ws.profiles,
      hasSharkcraftFolder: ws.hasSharkcraftFolder,
    },
    recommendedPresets,
    suggestedFiles,
    inferredPathConventions,
    inferredVerificationCommands,
    inferredBoundaryRules,
    inferredTemplateCandidates,
    inferredRules,
    inferredPipelines,
    detectedInstructionFiles,
    risks,
    nextCommands,
    readiness,
    monorepoSummary,
  };
}

// ─── Path conventions ────────────────────────────────────────────────────────

const PATH_CONVENTIONS: {
  id: string;
  dir: string;
  title: string;
  content: string;
  patterns: string[];
}[] = [
  {
    id: 'paths.src',
    dir: 'src',
    title: 'Application source under src/',
    content:
      'Application source code lives in src/. Avoid sibling top-level directories that duplicate src/ semantics.',
    patterns: ['src/**'],
  },
  {
    id: 'paths.services',
    dir: 'src/services',
    title: 'Services in src/services/',
    content:
      'Services live under src/services/ and follow the `*.service.ts` naming pattern.',
    patterns: ['src/services/**', '**/*.service.ts'],
  },
  {
    id: 'paths.utils',
    dir: 'src/utils',
    title: 'Utilities in src/utils/',
    content:
      'Pure utility functions live in src/utils/. One construct per file.',
    patterns: ['src/utils/**'],
  },
  {
    id: 'paths.components',
    dir: 'src/components',
    title: 'UI components in src/components/',
    content:
      'UI components live in src/components/<Name>/, one component per folder.',
    patterns: ['src/components/**'],
  },
  {
    id: 'paths.features',
    dir: 'src/features',
    title: 'Feature folders in src/features/',
    content:
      'Each feature gets its own folder under src/features/<feature-name>/.',
    patterns: ['src/features/**'],
  },
  {
    id: 'paths.libs',
    dir: 'libs',
    title: 'Libraries in libs/',
    content:
      'Reusable libraries live in libs/<lib-name>/. Public entrypoint at libs/<lib-name>/src/index.ts.',
    patterns: ['libs/**'],
  },
  {
    id: 'paths.packages',
    dir: 'packages',
    title: 'Packages in packages/',
    content:
      'Workspace packages live in packages/<pkg>/, each with its own package.json.',
    patterns: ['packages/**'],
  },
  {
    id: 'paths.apps',
    dir: 'apps',
    title: 'Apps in apps/',
    content: 'Deployable applications live in apps/<app-name>/.',
    patterns: ['apps/**'],
  },
];

const TEST_DIRS = ['tests', 'test', '__tests__'];

export function inferPathConventions(
  ws: IWorkspaceSummary,
  subDirs: ReadonlyMap<string, readonly string[]>,
): IInferredPathConvention[] {
  const out: IInferredPathConvention[] = [];
  for (const candidate of PATH_CONVENTIONS) {
    if (dirExists(ws.projectRoot, candidate.dir)) {
      out.push({
        id: candidate.id,
        title: candidate.title,
        content: candidate.content,
        patterns: candidate.patterns,
        reason: `${candidate.dir}/ directory present`,
      });
    }
  }
  // Test directory (tests / test / __tests__).
  for (const t of TEST_DIRS) {
    if (ws.topLevelDirs.includes(t)) {
      out.push({
        id: 'paths.tests',
        title: `Tests live in ${t}/`,
        content: `Test files live in ${t}/, mirroring src/. Use the *.spec.ts / *.test.ts suffix.`,
        patterns: [`${t}/**`, `**/*.spec.ts`, `**/*.test.ts`],
        reason: `${t}/ directory present`,
      });
      break;
    }
  }
  // Co-located tests under src/.
  if (
    subDirs.get('src')?.includes('__tests__') ||
    findOne(ws.projectRoot, /\.(spec|test)\.tsx?$/)
  ) {
    if (!out.some((p) => p.id === 'paths.tests')) {
      out.push({
        id: 'paths.tests',
        title: 'Co-located tests next to source',
        content:
          'Tests live next to the source they cover, with *.spec.ts or *.test.ts naming.',
        patterns: ['**/*.spec.ts', '**/*.test.ts'],
        reason: 'Detected *.spec/*.test files under src/',
      });
    }
  }
  return out;
}

// ─── Verification commands ───────────────────────────────────────────────────

const SCRIPT_KEYS: {
  scriptName: string | RegExp;
  id: string;
  label: string;
  /** Optional override for the resolved command. */
  override?: string;
}[] = [
  { scriptName: 'test', id: 'test', label: 'Tests' },
  { scriptName: 'typecheck', id: 'typecheck', label: 'Type check' },
  { scriptName: 'lint', id: 'lint', label: 'Lint' },
  { scriptName: 'build', id: 'build', label: 'Build' },
  { scriptName: 'test:mutation', id: 'mutation-tests', label: 'Mutation tests' },
  { scriptName: 'affected:test', id: 'affected-test', label: 'Affected tests' },
  { scriptName: 'affected:lint', id: 'affected-lint', label: 'Affected lint' },
];

export function inferVerificationCommands(
  ws: IWorkspaceSummary,
): IInferredVerificationCommand[] {
  const runner = packageManagerRunPrefix(effectivePackageManager(ws));
  const out: IInferredVerificationCommand[] = [];
  for (const [name, value] of Object.entries(ws.scripts)) {
    if (typeof value !== 'string') continue;
    const match = SCRIPT_KEYS.find((s) =>
      typeof s.scriptName === 'string'
        ? s.scriptName === name
        : s.scriptName.test(name),
    );
    if (!match) continue;
    if (out.some((v) => v.id === match.id)) continue;
    out.push({
      id: match.id,
      label: match.label,
      command: match.override ?? `${runner} ${name}`,
      trusted: true,
      reason: `package.json scripts.${name}`,
    });
  }
  return out;
}

function effectivePackageManager(ws: IWorkspaceSummary): PackageManager {
  if (ws.packageManager.manager !== PackageManager.Unknown) {
    return ws.packageManager.manager;
  }
  // Fall back to profile signals when no lockfile / packageManager field is set.
  if (ws.profiles.includes(WorkspaceProfile.HasBun)) return PackageManager.Bun;
  return PackageManager.Npm;
}

function packageManagerRunPrefix(manager: PackageManager): string {
  switch (manager) {
    case PackageManager.Bun:
      return 'bun run';
    case PackageManager.Pnpm:
      return 'pnpm';
    case PackageManager.Yarn:
      return 'yarn';
    case PackageManager.Npm:
      return 'npm run';
    default:
      return 'npm run';
  }
}

// ─── Boundary rule candidates ────────────────────────────────────────────────

const LAYER_ORDER = [
  'core',
  'common',
  'runtime',
  'kernel',
  'plugin',
  'adapter',
  'ui',
];

export function inferBoundaryRules(
  ws: IWorkspaceSummary,
  subDirs: ReadonlyMap<string, readonly string[]>,
): IInferredBoundaryRule[] {
  const out: IInferredBoundaryRule[] = [];
  // Detect layer prefixes in libs/* and packages/* and (top-level) layer dirs.
  const layerHits = new Map<string, string>(); // layer → from-pattern
  for (const layer of LAYER_ORDER) {
    if (ws.topLevelDirs.includes(layer)) {
      layerHits.set(layer, `${layer}/**`);
    }
  }
  for (const parent of ['libs', 'packages']) {
    const children = subDirs.get(parent) ?? [];
    for (const layer of LAYER_ORDER) {
      if (children.includes(layer)) {
        layerHits.set(layer, `${parent}/${layer}/**`);
      }
    }
  }
  if (layerHits.size < 3) return out;
  // Build one rule per detected layer that forbids importing from any higher
  // layer.
  for (let i = 0; i < LAYER_ORDER.length; i += 1) {
    const layer = LAYER_ORDER[i]!;
    if (!layerHits.has(layer)) continue;
    const higher = LAYER_ORDER.slice(i + 1).filter((l) => layerHits.has(l));
    if (higher.length === 0) continue;
    const forbiddenImports = higher.flatMap((l) => {
      const from = layerHits.get(l)!;
      const prefix = from.replace(/\/\*\*$/, '');
      return [prefix, `${prefix}/**`];
    });
    out.push({
      id: `architecture.${layer}.no-imports-up`,
      title: `${layer} must not import higher layers`,
      severity: 'error',
      from: [layerHits.get(layer)!],
      forbiddenImports,
      suggestedFix: `Move shared contracts down to ${layer}/ or invert the dependency so the higher layer depends on a contract defined in ${layer}/.`,
      reason: `${layer}/ + ${higher.length} higher layer(s) detected`,
    });
  }
  return out;
}

// ─── Template candidates ─────────────────────────────────────────────────────

interface ITemplatePatternSpec {
  id: string;
  name: string;
  description: string;
  pattern: RegExp;
  targetPathHint: string;
  highThreshold: number;
  kind: 'service' | 'utility' | 'test' | 'component';
}

const TEMPLATE_PATTERNS: ITemplatePatternSpec[] = [
  {
    id: 'inferred.service',
    name: 'Service',
    description: 'New service file under src/services/.',
    pattern: /\.service\.ts$/,
    targetPathHint: 'src/services/<name>.service.ts',
    highThreshold: 3,
    kind: 'service',
  },
  {
    id: 'inferred.util',
    name: 'Utility',
    description: 'New utility module under src/utils/.',
    pattern: /\.util\.ts$/,
    targetPathHint: 'src/utils/<name>.util.ts',
    highThreshold: 3,
    kind: 'utility',
  },
  {
    id: 'inferred.component',
    name: 'Component',
    description: 'New UI component.',
    pattern: /\.component\.tsx?$/,
    targetPathHint: 'src/components/<Name>/<Name>.component.tsx',
    highThreshold: 3,
    kind: 'component',
  },
  {
    id: 'inferred.spec',
    name: 'Spec / test file',
    description: 'New spec/test file colocated with source.',
    pattern: /\.(spec|test)\.tsx?$/,
    targetPathHint: 'src/<area>/<name>.spec.ts',
    highThreshold: 4,
    kind: 'test',
  },
];

export interface IInferTemplateCandidatesOptions {
  scaffoldTemplates?: boolean;
}

export function inferTemplateCandidates(
  ws: IWorkspaceSummary,
  options: IInferTemplateCandidatesOptions = {},
): IInferredTemplateCandidate[] {
  const out: IInferredTemplateCandidate[] = [];
  for (const t of TEMPLATE_PATTERNS) {
    const matches = findFiles(ws.projectRoot, t.pattern, { maxDepth: 5 });
    if (matches.length === 0) continue;
    const confidence =
      matches.length >= t.highThreshold
        ? 'high'
        : matches.length >= 2
          ? 'medium'
          : 'low';
    const sample = nodePath.relative(ws.projectRoot, matches[0]!);
    const candidate: IInferredTemplateCandidate = {
      id: t.id,
      name: t.name,
      description: t.description,
      sample,
      targetPathHint: t.targetPathHint,
      confidence,
      reason: `${matches.length} matching file(s) found`,
    };
    // Scaffolding is opt-in AND we never scaffold low-confidence single-sample
    // candidates — they overfit too easily.
    if (options.scaffoldTemplates && confidence !== 'low') {
      const result = inferTemplateBody({
        projectRoot: ws.projectRoot,
        sample,
        kind: t.kind,
        baseId: `inferred.typescript.${t.kind}`,
      });
      if (result.scaffold) candidate.scaffold = result.scaffold;
    }
    out.push(candidate);
  }
  return out;
}

// ─── Rule candidates ─────────────────────────────────────────────────────────

export function inferRules(ws: IWorkspaceSummary): IInferredRule[] {
  const out: IInferredRule[] = [];
  // Package manager.
  const manager = effectivePackageManager(ws);
  if (manager !== PackageManager.Unknown) {
    const evidence =
      ws.packageManager.manager !== PackageManager.Unknown
        ? `${ws.packageManager.manager} lockfile / manager field detected`
        : `inferred from project signals (${ws.profiles.includes(WorkspaceProfile.HasBun) ? 'has-bun profile' : 'fallback'})`;
    out.push({
      id: 'project.package-manager',
      title: `Use ${manager} for install/run`,
      content: `This repo uses ${manager}. Run scripts with \`${packageManagerRunPrefix(manager)} <script>\`.`,
      priority: 'medium',
      source: 'package-json',
      reason: evidence,
    });
  }
  // TypeScript.
  if (ws.hasTypeScript) {
    const strict = !!ws.tsConfig?.strict;
    out.push({
      id: 'typescript.strict-mode',
      title: strict
        ? 'TypeScript strict mode enabled'
        : 'Enable TypeScript strict mode',
      content: strict
        ? 'TypeScript strict mode is enabled. Keep it that way — do not weaken `strict` to land code.'
        : 'TypeScript strict mode is OFF. Turning it on is a one-line tsconfig change and significantly improves type safety. Plan a separate task for the cleanup.',
      priority: strict ? 'high' : 'medium',
      source: 'tsconfig',
      reason: `tsconfig strict=${strict}`,
    });
  }
  // Test runner.
  if (ws.profiles.includes(WorkspaceProfile.HasBunTest)) {
    out.push({
      id: 'testing.runner',
      title: 'Run tests with `bun test`',
      content:
        'Tests are executed via `bun test`. Use `bun test <path>` to run a single file.',
      priority: 'medium',
      source: 'package-json',
      reason: 'bun test script detected',
    });
  } else if (ws.profiles.includes(WorkspaceProfile.HasVitest)) {
    out.push({
      id: 'testing.runner',
      title: 'Run tests with Vitest',
      content: 'Tests are executed via Vitest. Configuration lives in vitest.config.ts.',
      priority: 'medium',
      source: 'package-json',
      reason: 'vitest dependency',
    });
  } else if (ws.profiles.includes(WorkspaceProfile.HasJest)) {
    out.push({
      id: 'testing.runner',
      title: 'Run tests with Jest',
      content: 'Tests are executed via Jest.',
      priority: 'medium',
      source: 'package-json',
      reason: 'jest dependency',
    });
  }
  // Monorepo layering.
  if (ws.profiles.includes(WorkspaceProfile.IsMonorepo)) {
    out.push({
      id: 'architecture.layer-order',
      title: 'Respect monorepo layer order',
      content:
        'Lower layers (core, common, runtime) must not import from higher layers (kernel, plugin, ui, apps). Run `shrk check boundaries` after touching cross-layer code.',
      priority: 'high',
      source: 'folder-structure',
      reason: 'monorepo layout detected',
    });
  }
  // ESLint.
  if (ws.profiles.includes(WorkspaceProfile.HasEslint)) {
    out.push({
      id: 'quality.lint-before-commit',
      title: 'Run lint before committing',
      content:
        'ESLint is configured. Run the lint script before opening a PR — CI will fail otherwise.',
      priority: 'medium',
      source: 'package-json',
      reason: 'eslint dependency',
    });
  }
  // AGENTS.md / CLAUDE.md present → recommend import.
  const detected = detectInstructionFiles(ws.projectRoot);
  for (const f of detected) {
    out.push({
      id: `import.${f.kind}`,
      title: `Existing ${f.kind === 'cursor-rules' ? '.cursor/rules' : f.kind} instructions detected`,
      content: `An existing ${f.path} ships agent instructions. Import them with \`${f.importCommand}\` to seed SharkCraft rules.`,
      priority: 'medium',
      source: 'agents-md',
      reason: `${f.path} present`,
    });
  }
  return out;
}

// ─── Pipeline candidates ─────────────────────────────────────────────────────

export function inferPipelines(
  ws: IWorkspaceSummary,
  verification: readonly IInferredVerificationCommand[],
): IInferredPipeline[] {
  const out: IInferredPipeline[] = [];
  const verifyIds = new Set(verification.map((v) => v.id));
  // unit-test pipeline whenever tests exist.
  if (ws.profiles.includes(WorkspaceProfile.HasTests)) {
    out.push({
      id: 'unit-test',
      title: 'Unit test pipeline',
      description: 'Pick a focused unit under test and write/run the spec.',
      steps: ['pick-target', 'write-spec', 'run-tests'],
      reason: 'test runner detected',
    });
  }
  // safe-generation pipeline when there is a builder/codegen-style setup.
  if (ws.hasTypeScript) {
    out.push({
      id: 'safe-generation',
      title: 'Safe generation pipeline',
      description:
        'Use `shrk gen --dry-run --save-plan` → review → `shrk apply --verify-signature` for risky writes.',
      steps: ['plan', 'review', 'apply'],
      reason: 'TypeScript project — codegen flows benefit from plan review',
    });
  }
  // feature-dev pipeline when there is both source structure + tests.
  if (
    ws.profiles.includes(WorkspaceProfile.HasTests) &&
    ws.topLevelDirs.includes('src')
  ) {
    out.push({
      id: 'feature-dev',
      title: 'Feature development pipeline',
      description:
        'Implement a new feature: plan → scaffold → wire → test → verify.',
      steps: ['plan', 'scaffold', 'wire-up', 'add-tests', 'verify'],
      reason: 'src/ + test runner present',
    });
  }
  // release-check when both build + test scripts exist.
  if (verifyIds.has('test') && verifyIds.has('build')) {
    out.push({
      id: 'release-check',
      title: 'Release readiness pipeline',
      description: 'Typecheck → lint → tests → build → boundary scan.',
      steps: ['typecheck', 'lint', 'test', 'build', 'boundaries'],
      reason: 'build + test scripts present',
    });
  }
  // pr-review when GitHub Actions present.
  if (ws.profiles.includes(WorkspaceProfile.HasGithubActions)) {
    out.push({
      id: 'pr-review',
      title: 'PR review packet pipeline',
      description:
        'Build the review packet on each PR: `shrk review --since origin/main --json`.',
      steps: ['diff', 'review-packet', 'comment'],
      reason: '.github/ directory present (GitHub Actions likely)',
    });
  }
  return out;
}

// ─── Instruction-file detection ──────────────────────────────────────────────

export function detectInstructionFiles(
  projectRoot: string,
): IDetectedInstructionFile[] {
  const out: IDetectedInstructionFile[] = [];
  if (existsSync(nodePath.join(projectRoot, 'AGENTS.md'))) {
    out.push({
      kind: 'agents-md',
      path: 'AGENTS.md',
      importCommand: 'shrk import agents AGENTS.md',
    });
  }
  if (existsSync(nodePath.join(projectRoot, 'CLAUDE.md'))) {
    out.push({
      kind: 'claude-md',
      path: 'CLAUDE.md',
      importCommand: 'shrk import claude CLAUDE.md',
    });
  }
  const cursor = nodePath.join(projectRoot, '.cursor', 'rules');
  if (existsSync(cursor)) {
    out.push({
      kind: 'cursor-rules',
      path: '.cursor/rules',
      importCommand: 'shrk import cursor .cursor/rules',
    });
  }
  return out;
}

// ─── Risks / warnings ────────────────────────────────────────────────────────

function collectRisks(
  ws: IWorkspaceSummary,
  templateCandidates: readonly IInferredTemplateCandidate[],
): string[] {
  const risks: string[] = [];
  if (!ws.hasPackageJson) {
    risks.push(
      'No package.json found — verification commands and rules cannot be inferred from scripts.',
    );
  }
  if (!ws.hasTypeScript) {
    risks.push(
      'No TypeScript signal detected — many templates assume TS. Review inferred templates carefully.',
    );
  }
  for (const c of templateCandidates) {
    if (c.confidence === 'low') {
      risks.push(
        `Template candidate "${c.id}" rests on a single sample file (${c.sample ?? 'unknown'}); review before keeping.`,
      );
    }
  }
  return risks;
}

// ─── Suggested files ─────────────────────────────────────────────────────────

function buildSuggestedFiles(ws: IWorkspaceSummary): string[] {
  if (ws.hasSharkcraftFolder) {
    return [
      'sharkcraft/onboarding/onboarding-report.md',
      'sharkcraft/onboarding/inferred-rules.draft.ts',
      'sharkcraft/onboarding/inferred-paths.draft.ts',
      'sharkcraft/onboarding/inferred-templates.draft.ts',
      'sharkcraft/onboarding/inferred-boundaries.draft.ts',
      'sharkcraft/onboarding/inferred-pipelines.draft.ts',
    ];
  }
  return [
    'sharkcraft/sharkcraft.config.ts',
    'sharkcraft/knowledge.ts',
    'sharkcraft/rules.ts',
    'sharkcraft/paths.ts',
    'sharkcraft/templates.ts',
    'sharkcraft/pipelines.ts',
    'sharkcraft/onboarding/onboarding-report.md',
    'sharkcraft/onboarding/inferred-rules.draft.ts',
    'sharkcraft/onboarding/inferred-paths.draft.ts',
    'sharkcraft/onboarding/inferred-templates.draft.ts',
    'sharkcraft/onboarding/inferred-boundaries.draft.ts',
    'sharkcraft/onboarding/inferred-pipelines.draft.ts',
  ];
}

// ─── Readiness estimate ──────────────────────────────────────────────────────

function gradeOf(score: number): ReadinessGrade {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'partial';
  return 'poor';
}

function estimateReadinessImpact(
  inspection: ISharkcraftInspection,
  paths: readonly IInferredPathConvention[],
  rules: readonly IInferredRule[],
  pipelines: readonly IInferredPipeline[],
  verification: readonly IInferredVerificationCommand[],
  boundaryRules: readonly IInferredBoundaryRule[],
): IReadinessEstimate {
  const current = buildAiReadinessReport(inspection);

  // Heuristic: each dimension gets a modest bump from the inferred additions.
  // We DO NOT claim certainty. Cap the bonus to keep things honest.
  let bonus = 0;
  if (!inspection.configFile) bonus += 5; // creating config alone.
  if (rules.length >= 3) bonus += 5;
  if (paths.length >= 3) bonus += 4;
  if (pipelines.length >= 2) bonus += 3;
  if (verification.length >= 1) bonus += 2;
  if (boundaryRules.length >= 1) bonus += 3;
  // Cap raw uplift to a tasteful ceiling so we don't claim "poor → excellent".
  bonus = Math.min(20, bonus);

  const expectedScore = Math.min(95, current.score + bonus);

  const topImprovements = [
    !inspection.configFile
      ? 'Create sharkcraft/sharkcraft.config.ts.'
      : 'Keep config in sync with inferred drafts.',
    rules.length > 0
      ? `Adopt ${rules.length} inferred rule${rules.length === 1 ? '' : 's'}.`
      : 'Author rules for the most violated conventions.',
    paths.length > 0
      ? `Adopt ${paths.length} inferred path convention${paths.length === 1 ? '' : 's'}.`
      : 'Author path conventions for the directories you actually use.',
    pipelines.length > 0
      ? `Adopt ${pipelines.length} pipeline${pipelines.length === 1 ? '' : 's'}.`
      : 'Define at least feature-dev + safe-generation pipelines.',
    boundaryRules.length > 0
      ? `Adopt ${boundaryRules.length} boundary rule${boundaryRules.length === 1 ? '' : 's'}.`
      : 'Author boundary rules once your layer boundaries stabilise.',
  ];

  return {
    current: current.grade,
    expected: gradeOf(expectedScore),
    currentScore: current.score,
    expectedScore,
    topImprovements,
  };
}

// ─── Next commands ───────────────────────────────────────────────────────────

interface INextCommandsContext {
  scaffoldTemplates: boolean;
  isMonorepo: boolean;
}

function buildNextCommands(
  hasSharkcraftFolder: boolean,
  ctx: INextCommandsContext = { scaffoldTemplates: false, isMonorepo: false },
): string[] {
  const cmds: string[] = [];
  if (!hasSharkcraftFolder) {
    cmds.push('shrk init  # scaffold sharkcraft/');
  }
  cmds.push(
    'shrk onboard --write-drafts  # write drafts under sharkcraft/onboarding/',
    'shrk onboard --write-drafts --scaffold-templates  # also draft runnable templates',
    'shrk onboard --write-drafts --import-agents       # also import existing agent rules',
    'shrk onboard --diff                              # compare drafts to live config',
    'shrk doctor                  # validate config + entries',
    'shrk coverage                # see what is still missing',
    'shrk task "<task>"           # try a focused task packet',
  );
  if (ctx.isMonorepo) {
    cmds.push(
      'shrk onboard --dry-run       # re-run after adding per-package configs',
    );
  }
  return cmds;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.idea',
  '.vscode',
  'dist',
  'build',
  '.cache',
  '.nx',
  '.turbo',
  'coverage',
]);

function dirExists(root: string, rel: string): boolean {
  try {
    const full = nodePath.join(root, rel);
    return existsSync(full) && statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function listSubDirs(projectRoot: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!existsSync(projectRoot)) return out;
  let topLevel: string[] = [];
  try {
    topLevel = readdirSync(projectRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name))
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const top of topLevel) {
    try {
      const fullTop = nodePath.join(projectRoot, top);
      const children = readdirSync(fullTop, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name))
        .map((e) => e.name);
      out.set(top, children);
    } catch {
      out.set(top, []);
    }
  }
  return out;
}

function findOne(projectRoot: string, pattern: RegExp): boolean {
  const found = findFiles(projectRoot, pattern, { maxDepth: 4 });
  return found.length > 0;
}

function reorderForPreferredPreset(
  recs: readonly IPresetRecommendation[],
  preferredId: string,
  registry?: { get(id: string): IPreset | undefined },
): IPresetRecommendation[] {
  const idx = recs.findIndex((r) => r.preset.id === preferredId);
  if (idx > 0) {
    const out = [...recs];
    const [pinned] = out.splice(idx, 1);
    out.unshift(pinned!);
    return out;
  }
  if (idx === 0) return [...recs];
  // Pin the preferred preset to the front even if it isn't in the
  // recommendations bucket (e.g. the miss penalty dropped it out of the
  // top N). We look it up from the registry and synthesize a low-score
  // recommendation entry so the downstream consumer still sees `id` at
  // position 0.
  if (registry) {
    const preset = registry.get(preferredId);
    if (preset) {
      return [
        {
          preset,
          score: 0,
          confidence: 'low' as const,
          reasons: ['pinned via preferredPreset option'],
        },
        ...recs,
      ];
    }
  }
  return [...recs];
}
