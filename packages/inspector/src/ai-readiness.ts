import { KnowledgeType, hasActionHints } from '@shrkcrft/knowledge';
import { WorkspaceProfile } from '@shrkcrft/workspace';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { diagnoseActionHints } from './action-hint-diagnostics.ts';
import { runDoctor } from './sharkcraft-inspector.ts';

/**
 * Entry types that describe a *location* or a *fact* rather than an action, so
 * they are not expected to carry actionHints and are excluded from the
 * action-hint coverage metric. Mirrors the skip set in
 * `action-hint-diagnostics.ts` (keep the two in sync).
 */
const HINT_EXEMPT_TYPES: ReadonlySet<string> = new Set(['path', 'overview', 'technical']);

/**
 * Per-dimension applies-to status.
 *
 *   - `core` — dimension applies to this workspace shape; counted in the
 *     aggregate score.
 *   - `advisory` — dimension applies but is not load-bearing for the
 *     shape; shown in output, NOT counted in the aggregate, and does NOT
 *     produce a recommendation. Lets the user see "you could add this"
 *     without dragging the score down for a perfectly-shaped repo.
 *   - `n/a-for-shape` — dimension is irrelevant to this workspace shape
 *     (e.g. "templates" for a CLI library that doesn't scaffold
 *     anything). Hidden from default output, NOT counted, NO
 *     recommendation. Surfaced with `--show-na`.
 */
export type DimensionAppliesTo = 'core' | 'advisory' | 'n/a-for-shape';

export interface IReadinessDimension {
  id: string;
  title: string;
  /** 0–10 score. */
  score: number;
  /** Weight applied to the score in the final aggregate (only used when applies === 'core'). */
  weight: number;
  /** Free-form note explaining the score. */
  note: string;
  /** Does this dimension apply to the detected workspace shape? */
  applies: DimensionAppliesTo;
  /** When applies !== 'core', a one-line reason the dimension was skipped. */
  appliesReason?: string;
}

export type ReadinessGrade = 'excellent' | 'good' | 'partial' | 'poor';

/**
 * One of four binary verdicts surfaced in the doctor output. Replaces
 * the older "look at the 0-100 score" UX with a clear yes/no for the
 * two questions users actually want answered.
 */
export interface IReadinessVerdicts {
  /** Can an AI agent rely on shrk to apply changes safely? */
  readyForAgentWrites: boolean;
  /** Can an AI agent use shrk's read-only surface (context / task)? */
  readyForAgentReads: boolean;
  /** Concrete things blocking `readyForAgentWrites`. */
  blockers: readonly string[];
}

export interface IReadinessReport {
  /** 0..100 weighted score, counting only `core` dimensions. */
  score: number;
  grade: ReadinessGrade;
  dimensions: IReadinessDimension[];
  /** Up to 5 prioritized actions to improve the score (only from core dims). */
  topRecommendations: string[];
  /** Honest binary verdicts that don't depend on softcap scoring. */
  verdicts: IReadinessVerdicts;
  /** Detected workspace shape — drives which dimensions count as core. */
  workspaceShape: IWorkspaceShape;
}

/**
 * Coarse classification of the workspace, used to decide which readiness
 * dimensions are load-bearing. Derived from `WorkspaceProfile[]`.
 */
export interface IWorkspaceShape {
  /** Best-effort one-line description of the shape. */
  label: string;
  /** True if the workspace publishes a library (no user-facing scaffolding). */
  isLibrary: boolean;
  /** True if the workspace runs a service (HTTP / queue / daemon). */
  isService: boolean;
  /** True if the workspace is a monorepo (Nx / Turborepo / pnpm-workspaces). */
  isMonorepo: boolean;
  /** True if the workspace owns end-user code (Angular app / Next.js app / Nest service / generic frontend / backend). */
  isApplication: boolean;
}

function gradeOf(score: number): ReadinessGrade {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'partial';
  return 'poor';
}

/**
 * Map a count into a 0..10 score with a soft cap. Once the count reaches
 * `softCap`, further increases yield diminishing returns; the score levels
 * off at `softCap * 1.5` so a repo with 1000 entries doesn't outscore one
 * with focused 30.
 */
function softCapScore(count: number, softCap: number): number {
  if (count <= 0) return 0;
  if (count >= softCap * 1.5) return 10;
  if (count >= softCap) {
    const extra = count - softCap;
    const slack = softCap * 0.5;
    return Math.min(10, 8 + Math.round((extra / slack) * 2));
  }
  return Math.min(8, Math.round((count / softCap) * 8));
}

const PLACEHOLDER_MARKERS = [/\bTODO\b/i, /\bTBD\b/i, /\bplaceholder\b/i, /\bfill\s*in\b/i];
const WORKFLOW_TYPES = new Set(['workflow', 'decision', 'convention']);

function isCriticalOrHighWorkflow(entry: { type: unknown; priority: unknown }): boolean {
  if (!WORKFLOW_TYPES.has(String(entry.type))) return false;
  const p = String(entry.priority);
  return p === 'critical' || p === 'high';
}

/**
 * Classify the workspace from its profile flags. Used to mark dimensions
 * core / advisory / n/a so the aggregate score reflects what actually
 * matters for this repo.
 */
function classifyShape(profiles: readonly string[]): IWorkspaceShape {
  const has = (p: WorkspaceProfile): boolean => profiles.includes(p);
  const isLibrary = has(WorkspaceProfile.IsLibrary);
  const isService = has(WorkspaceProfile.IsService);
  const isMonorepo =
    has(WorkspaceProfile.IsMonorepo) ||
    has(WorkspaceProfile.HasNx) ||
    has(WorkspaceProfile.HasTurborepo) ||
    has(WorkspaceProfile.HasPackageWorkspaces);
  const isApplication =
    !isLibrary &&
    (has(WorkspaceProfile.IsFrontend) ||
      has(WorkspaceProfile.IsBackend) ||
      isService);
  let label: string;
  if (isMonorepo) {
    label = isLibrary ? 'library monorepo' : 'monorepo';
  } else if (isLibrary) {
    label = 'library';
  } else if (isService) {
    label = 'service';
  } else if (has(WorkspaceProfile.IsFrontend)) {
    label = 'frontend app';
  } else if (has(WorkspaceProfile.IsBackend)) {
    label = 'backend app';
  } else if (has(WorkspaceProfile.HasTypeScript)) {
    label = 'TypeScript project';
  } else {
    label = 'unclassified';
  }
  return { label, isLibrary, isService, isMonorepo, isApplication };
}

/**
 * Deterministic AI-readiness report.
 *
 * Replaces the original "single 0-100 score" UX with a shape-aware
 * report. Each dimension is classified as:
 *
 *   - `core` — counts in the aggregate score; produces a recommendation
 *     when below threshold.
 *   - `advisory` — shown but doesn't drag the score down; no
 *     recommendation. Used for dimensions that are nice-to-have but
 *     not load-bearing for the detected workspace shape (e.g. docs in
 *     a CLI library).
 *   - `n/a-for-shape` — irrelevant to this workspace; hidden by
 *     default. Lets a CLI library skip "add templates" without
 *     manually suppressing every release.
 *
 * Two binary verdicts ride alongside the score:
 *   - `readyForAgentWrites` — every gate an autonomous agent would need
 *     before issuing `shrk apply` (config + cli-only safety + clean
 *     doctor).
 *   - `readyForAgentReads` — every gate a read-only agent (e.g. an MCP
 *     context lookup) would need (knowledge entries loaded + doctor
 *     clean).
 *
 * Numerical penalties stay explicit:
 *   - Quantity-only "stuff a registry full of entries" is capped via softCap.
 *   - Duplicate-id warnings reduce data-quality dimension.
 *   - Placeholder docs (TODO / TBD / "fill in") reduce docs dimension.
 *   - Critical/high workflow entries missing actionHints reduce safety dim.
 *   - Doctor health stays a hard gate.
 */
export function buildAiReadinessReport(inspection: ISharkcraftInspection): IReadinessReport {
  const dims: IReadinessDimension[] = [];
  const recs: string[] = [];
  const shape = classifyShape(inspection.workspace.profiles);

  // Reusable applies-to predicates.
  const templatesApply: DimensionAppliesTo = shape.isLibrary && !shape.isMonorepo
    ? 'n/a-for-shape'
    : shape.isApplication
      ? 'core'
      : 'advisory';
  const pipelinesApply: DimensionAppliesTo = shape.isLibrary && !shape.isMonorepo
    ? 'n/a-for-shape'
    : 'advisory';
  const pathsApply: DimensionAppliesTo = shape.isMonorepo || shape.isApplication
    ? 'core'
    : 'advisory';
  const docsApply: DimensionAppliesTo = shape.isApplication || shape.isMonorepo
    ? 'core'
    : 'advisory';

  // 1) Config present — always core (this is the "did you opt in?" signal).
  dims.push({
    id: 'config',
    title: 'sharkcraft.config.ts present',
    weight: 0.5,
    score: inspection.configFile ? 10 : 0,
    note: inspection.configFile
      ? `loaded from ${inspection.configFile}`
      : 'missing — using defaults',
    applies: 'core',
  });
  if (!inspection.configFile) {
    recs.push('Create sharkcraft/sharkcraft.config.ts to opt in to project-specific config.');
  }

  // 2) Knowledge entries — softcap at 15 (focused) and full at 22.
  const k = inspection.knowledgeEntries.length;
  dims.push({
    id: 'knowledge',
    title: 'Knowledge entries loaded',
    weight: 1.0,
    score: softCapScore(k, 15),
    note: `${k} entries (softcap 15, full at 22)`,
    applies: 'core',
  });
  if (k < 10) recs.push('Add more structured knowledge entries (target: 10+).');

  // 3) Rules — softcap at 8.
  const rules = inspection.knowledgeEntries.filter((e) => String(e.type) === KnowledgeType.Rule);
  dims.push({
    id: 'rules',
    title: 'Rules',
    weight: 1.0,
    score: softCapScore(rules.length, 8),
    note: `${rules.length} rules (softcap 8)`,
    applies: 'core',
  });
  if (rules.length < 5) recs.push('Add at least 5 rules describing coding/architecture conventions.');

  // 4) Path conventions — core for monorepos / applications, advisory otherwise.
  const paths = inspection.pathService.list();
  dims.push({
    id: 'paths',
    title: 'Path conventions',
    weight: 0.8,
    score: softCapScore(paths.length, 6),
    note: `${paths.length} path conventions (softcap 6)`,
    applies: pathsApply,
    appliesReason:
      pathsApply === 'advisory'
        ? 'Path conventions matter most for monorepos and applications with explicit src/ layouts.'
        : undefined,
  });
  if (pathsApply === 'core' && paths.length < 4) {
    recs.push('Add path conventions for src/, services/, utils/, tests/ etc.');
  }

  // 5) Templates — n/a for pure libraries; core for applications;
  //    advisory for monorepos (often useful but not load-bearing).
  const t = inspection.templates.length;
  dims.push({
    id: 'templates',
    title: 'Templates',
    weight: 0.8,
    score: softCapScore(t, 4),
    note: `${t} templates (softcap 4)`,
    applies: templatesApply,
    appliesReason:
      templatesApply === 'n/a-for-shape'
        ? 'Libraries don\'t scaffold downstream code — templates are not load-bearing here.'
        : templatesApply === 'advisory'
          ? 'Templates help generate consistent constructs, but the repo can be agent-ready without them.'
          : undefined,
  });
  if (templatesApply === 'core' && t < 3) {
    recs.push('Define templates for the constructs you generate most often.');
  }

  // 6) Pipelines — n/a for pure libraries; advisory for everything else.
  //    Pipelines are nice but rarely block agent workflows.
  const p = inspection.pipelines.length;
  dims.push({
    id: 'pipelines',
    title: 'Pipelines',
    weight: 0.8,
    score: softCapScore(p, 3),
    note: `${p} pipelines (softcap 3)`,
    applies: pipelinesApply,
    appliesReason:
      pipelinesApply === 'n/a-for-shape'
        ? 'Libraries don\'t orchestrate feature pipelines — this dimension does not apply.'
        : 'Pipelines describe preferred flows; a repo can be agent-ready with just rules + path conventions.',
  });
  // No recommendation when pipelines is advisory — the old "add a pipeline"
  // exhortation fired on libraries it shouldn't have.

  // 7) Action-hint coverage — fraction of HINT-ELIGIBLE entries that carry
  // hints. Path / overview / technical entries describe a location or a fact
  // rather than an action, so the action-hint quality doctor deliberately
  // doesn't grade them (see action-hint-diagnostics). Counting them in the
  // denominator penalised the score for structural non-gaps — an entry that
  // *can't* meaningfully carry action hints isn't a missing one — so they are
  // excluded from both numerator and denominator here too.
  const hintEligible = inspection.knowledgeEntries.filter(
    (e) => !HINT_EXEMPT_TYPES.has(String(e.type).toLowerCase()),
  );
  const eligibleCount = hintEligible.length;
  const withHints = hintEligible.filter((e) => hasActionHints(e)).length;
  const hintsScore =
    eligibleCount === 0 ? 0 : Math.min(10, Math.round((withHints / eligibleCount) * 20));
  dims.push({
    id: 'action-hints',
    title: 'Entries with action hints',
    weight: 1.2,
    score: hintsScore,
    note: `${withHints} of ${eligibleCount} hint-eligible entries carry actionHints`,
    applies: 'core',
  });
  if (hintsScore < 7)
    recs.push(
      'Add actionHints to high-priority entries (commands, mcpTools, forbiddenActions, relatedKnowledge).',
    );

  // 8) Verification commands
  const haveVerify = inspection.knowledgeEntries.some(
    (e) => (e.actionHints?.verificationCommands?.length ?? 0) > 0,
  );
  dims.push({
    id: 'verification',
    title: 'Verification commands defined',
    weight: 0.6,
    score: haveVerify ? 10 : 0,
    note: haveVerify ? 'at least one entry lists verification commands' : 'no entry lists verification commands',
    applies: 'core',
  });
  if (!haveVerify) recs.push('Add verificationCommands to safety/generation rules (e.g. typecheck + tests).');

  // 9) Forbidden actions
  const haveForbidden = inspection.knowledgeEntries.some(
    (e) => (e.actionHints?.forbiddenActions?.length ?? 0) > 0,
  );
  dims.push({
    id: 'forbidden',
    title: 'Forbidden actions declared',
    weight: 0.6,
    score: haveForbidden ? 10 : 0,
    note: haveForbidden ? 'at least one entry lists forbiddenActions' : 'no entry lists forbiddenActions',
    applies: 'core',
  });
  if (!haveForbidden) recs.push('Add forbiddenActions to clarify what agents must NOT do.');

  // 10) Docs — softcap at 4. Penalize placeholder docs. Advisory for libraries.
  const docFiles = inspection.sourceFiles.filter((s) => s.endsWith('.md'));
  let placeholderDocCount = 0;
  for (const entry of inspection.knowledgeEntries) {
    if (!entry.source?.origin?.endsWith('.md')) continue;
    if (PLACEHOLDER_MARKERS.some((re) => re.test(entry.content))) {
      placeholderDocCount += 1;
    }
  }
  const docsRaw = softCapScore(docFiles.length, 4);
  const docsPenalty = Math.min(docsRaw, placeholderDocCount * 2);
  dims.push({
    id: 'docs',
    title: 'Docs / task files',
    weight: 0.4,
    score: Math.max(0, docsRaw - docsPenalty),
    note:
      placeholderDocCount > 0
        ? `${docFiles.length} markdown files (-${docsPenalty} for ${placeholderDocCount} placeholder markers)`
        : `${docFiles.length} markdown files`,
    applies: docsApply,
    appliesReason:
      docsApply === 'advisory'
        ? 'Standalone libraries communicate via README + API docs more than per-task markdown.'
        : undefined,
  });
  if (placeholderDocCount > 0) {
    recs.push(`Replace TODO/placeholder markers in ${placeholderDocCount} doc/task file(s).`);
  }

  // 11) Doctor health — passes is a near-required gate.
  const doctor = runDoctor(inspection);
  const structuralWarnings = doctor.checks.filter(
    (c) => c.severity === 'warning' && !c.id.startsWith('actionhints-'),
  ).length;
  const doctorScore = doctor.passed ? Math.max(0, 10 - structuralWarnings) : 0;
  dims.push({
    id: 'doctor',
    title: 'Doctor health',
    weight: 1.0,
    score: doctorScore,
    note: doctor.passed
      ? `passed (${structuralWarnings} structural warnings, ${doctor.summary.warnings} total)`
      : `${doctor.summary.errors} errors`,
    applies: 'core',
  });
  if (!doctor.passed) recs.push('Fix doctor errors before relying on agent workflows.');

  // 12) Pack discovery health — n/a when no packs are installed (don't
  //     reward inaction with a neutral 5).
  const packs = inspection.packs;
  const packsApply: DimensionAppliesTo =
    packs.discoveredPacks.length === 0 ? 'n/a-for-shape' : 'core';
  const packsScore =
    packs.discoveredPacks.length === 0
      ? 0 // would-be neutral 5 was masking how often this dim doesn't apply
      : packs.invalidPacks.length === 0
        ? 10
        : 4;
  dims.push({
    id: 'packs',
    title: 'Pack discovery health',
    weight: 0.4,
    score: packsScore,
    note:
      packs.discoveredPacks.length === 0
        ? 'no packs discovered'
        : `${packs.validPacks.length}/${packs.discoveredPacks.length} packs valid`,
    applies: packsApply,
    appliesReason:
      packsApply === 'n/a-for-shape'
        ? 'No SharkCraft packs installed — pack-discovery health does not apply.'
        : undefined,
  });
  if (packsApply === 'core' && packs.invalidPacks.length > 0) {
    recs.push('Fix invalid pack manifests (see `shrk packs doctor`).');
  }

  // 13) Generation safety — flagship cli-only write policy rule required.
  const hasDryRunDefault = inspection.knowledgeEntries.some(
    (e) =>
      e.actionHints?.writePolicy === 'cli-only' ||
      (e.actionHints?.forbiddenActions ?? []).some((f) => /write through mcp/i.test(f)),
  );
  const workflowMissingHints = inspection.knowledgeEntries.filter(
    (e) => isCriticalOrHighWorkflow(e) && !hasActionHints(e),
  ).length;
  let safetyScore = hasDryRunDefault ? 10 : 3;
  if (workflowMissingHints > 0) {
    safetyScore = Math.max(0, safetyScore - Math.min(safetyScore, workflowMissingHints * 2));
  }
  dims.push({
    id: 'safety',
    title: 'Generation safety readiness',
    weight: 1.0,
    score: safetyScore,
    note: hasDryRunDefault
      ? workflowMissingHints > 0
        ? `cli-only write policy present, but ${workflowMissingHints} critical/high workflow entry/entries lack actionHints`
        : 'cli-only write policy + forbidden-actions present'
      : 'no entry declares cli-only write policy',
    applies: 'core',
  });
  if (!hasDryRunDefault) {
    recs.push('Add a critical safety rule with writePolicy:"cli-only" and "do not write through MCP".');
  }
  if (workflowMissingHints > 0) {
    recs.push(`Add actionHints to ${workflowMissingHints} critical/high workflow entry/entries.`);
  }

  // 14) Action-hint quality (delegates to diagnostics).
  const hintReport = diagnoseActionHints(inspection.knowledgeEntries);
  const hintIssueScore =
    hintReport.evaluatedEntryCount === 0
      ? 5
      : Math.max(
          0,
          10 -
            Math.min(10, Math.round((hintReport.issues.length / hintReport.evaluatedEntryCount) * 5)),
        );
  dims.push({
    id: 'hint-quality',
    title: 'Action-hint quality',
    weight: 0.6,
    score: hintIssueScore,
    note: `${hintReport.issues.length} quality warnings across ${hintReport.evaluatedEntryCount} relevant entries`,
    applies: 'core',
  });

  // 15) Data quality — duplicate ids surface as warnings.
  const dupCount = inspection.validationIssues.filter((v) => v.code === 'duplicate-id').length;
  const dataQualityScore = Math.max(0, 10 - Math.min(10, dupCount * 2));
  dims.push({
    id: 'data-quality',
    title: 'Data quality (no duplicates)',
    weight: 0.5,
    score: dataQualityScore,
    note:
      dupCount === 0
        ? 'no duplicate knowledge ids'
        : `${dupCount} duplicate id(s) — first occurrence kept`,
    applies: 'core',
  });
  if (dupCount > 0) recs.push(`Resolve ${dupCount} duplicate knowledge id(s).`);

  // Aggregate over `core` dimensions only — advisory + n/a do not count.
  const coreDims = dims.filter((d) => d.applies === 'core');
  const totalWeight = coreDims.reduce((sum, d) => sum + d.weight, 0);
  const weightedSum = coreDims.reduce((sum, d) => sum + d.score * d.weight, 0);
  const score = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 10) : 0;

  // Binary verdicts — honest yes/no rather than a fuzzy score.
  const blockers: string[] = [];
  if (!doctor.passed) blockers.push('doctor reports errors');
  if (!inspection.configFile) blockers.push('sharkcraft.config.ts missing');
  if (!hasDryRunDefault) blockers.push('no cli-only write policy rule');
  if (k === 0) blockers.push('no knowledge entries loaded');
  const readyForAgentWrites = blockers.length === 0;
  const readyForAgentReads = doctor.passed && k > 0;

  return {
    score,
    grade: gradeOf(score),
    dimensions: dims,
    topRecommendations: recs.slice(0, 5),
    verdicts: {
      readyForAgentWrites,
      readyForAgentReads,
      blockers,
    },
    workspaceShape: shape,
  };
}
