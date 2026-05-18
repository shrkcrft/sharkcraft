import { KnowledgeType, hasActionHints } from '@shrkcrft/knowledge';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { diagnoseActionHints } from './action-hint-diagnostics.ts';
import { runDoctor } from './sharkcraft-inspector.ts';

export interface IReadinessDimension {
  id: string;
  title: string;
  /** 0–10 score. */
  score: number;
  /** Weight applied to the score in the final aggregate. */
  weight: number;
  /** Free-form note explaining the score. */
  note: string;
}

export type ReadinessGrade = 'excellent' | 'good' | 'partial' | 'poor';

export interface IReadinessReport {
  /** 0..100 weighted score. */
  score: number;
  grade: ReadinessGrade;
  dimensions: IReadinessDimension[];
  /** Up to 5 prioritized actions to improve the score. */
  topRecommendations: string[];
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
 * Deterministic 0..100 AI-readiness score. Penalties are explicit:
 *  - Quantity-only "stuff a registry full of entries" is capped via softCap.
 *  - Duplicate-id warnings reduce data-quality dimension.
 *  - Placeholder docs (TODO / TBD / "fill in") reduce docs dimension.
 *  - Critical/high workflow entries missing actionHints reduce safety dim.
 *  - Doctor health stays a hard gate.
 */
export function buildAiReadinessReport(inspection: ISharkcraftInspection): IReadinessReport {
  const dims: IReadinessDimension[] = [];
  const recs: string[] = [];

  // 1) Config present
  dims.push({
    id: 'config',
    title: 'sharkcraft.config.ts present',
    weight: 0.5,
    score: inspection.configFile ? 10 : 0,
    note: inspection.configFile
      ? `loaded from ${inspection.configFile}`
      : 'missing — using defaults',
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
  });
  if (rules.length < 5) recs.push('Add at least 5 rules describing coding/architecture conventions.');

  // 4) Path conventions — softcap at 6.
  const paths = inspection.pathService.list();
  dims.push({
    id: 'paths',
    title: 'Path conventions',
    weight: 0.8,
    score: softCapScore(paths.length, 6),
    note: `${paths.length} path conventions (softcap 6)`,
  });
  if (paths.length < 4) recs.push('Add path conventions for src/, services/, utils/, tests/ etc.');

  // 5) Templates — softcap at 4.
  const t = inspection.templates.length;
  dims.push({
    id: 'templates',
    title: 'Templates',
    weight: 0.8,
    score: softCapScore(t, 4),
    note: `${t} templates (softcap 4)`,
  });
  if (t < 3) recs.push('Define templates for the constructs you generate most often.');

  // 6) Pipelines — softcap at 3.
  const p = inspection.pipelines.length;
  dims.push({
    id: 'pipelines',
    title: 'Pipelines',
    weight: 0.8,
    score: softCapScore(p, 3),
    note: `${p} pipelines (softcap 3)`,
  });
  if (p < 2) recs.push('Add at least one feature-dev or safe-generation pipeline.');

  // 7) Action-hint coverage — fraction of entries that carry hints.
  const withHints = inspection.knowledgeEntries.filter((e) => hasActionHints(e)).length;
  const hintsScore =
    k === 0 ? 0 : Math.min(10, Math.round((withHints / Math.max(k, 1)) * 20));
  dims.push({
    id: 'action-hints',
    title: 'Entries with action hints',
    weight: 1.2,
    score: hintsScore,
    note: `${withHints} of ${k} entries carry actionHints`,
  });
  if (hintsScore < 7) recs.push('Add actionHints to high-priority rules (commands, mcpTools, forbiddenActions).');

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
  });
  if (!haveForbidden) recs.push('Add forbiddenActions to clarify what agents must NOT do.');

  // 10) Docs — softcap at 4. Penalize placeholder docs.
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
  });
  if (placeholderDocCount > 0) {
    recs.push(
      `Replace TODO/placeholder markers in ${placeholderDocCount} doc/task file(s).`,
    );
  }

  // 11) Doctor health — passes is a near-required gate.
  //
  // Action-hint quality warnings are also surfaced by the doctor, but the
  // dedicated `hint-quality` dimension below already scores them. Counting
  // them here too would punish the same warning twice and crush the score
  // once a repo crosses ten hint warnings. Exclude them from this dimension.
  const doctor = runDoctor(inspection);
  const structuralWarnings = doctor.checks.filter(
    (c) =>
      c.severity === 'warning' &&
      !c.id.startsWith('actionhints-'),
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
  });
  if (!doctor.passed) recs.push('Fix doctor errors before relying on agent workflows.');

  // 12) Pack discovery health
  const packs = inspection.packs;
  const packsScore =
    packs.discoveredPacks.length === 0
      ? 5 // neutral when no packs are installed
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
  });
  if (packs.invalidPacks.length > 0) {
    recs.push('Fix invalid pack manifests (see `shrk packs doctor`).');
  }

  // 13) Generation safety — flagship cli-only write policy rule required.
  const hasDryRunDefault = inspection.knowledgeEntries.some(
    (e) =>
      e.actionHints?.writePolicy === 'cli-only' ||
      (e.actionHints?.forbiddenActions ?? []).some((f) => /write through mcp/i.test(f)),
  );
  // Additionally penalize when any critical/high workflow entry lacks hints.
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
  });
  if (dupCount > 0) recs.push(`Resolve ${dupCount} duplicate knowledge id(s).`);

  // Aggregate.
  const totalWeight = dims.reduce((sum, d) => sum + d.weight, 0);
  const weightedSum = dims.reduce((sum, d) => sum + d.score * d.weight, 0);
  const score = Math.round((weightedSum / totalWeight) * 10);

  return {
    score,
    grade: gradeOf(score),
    dimensions: dims,
    topRecommendations: recs.slice(0, 5),
  };
}
