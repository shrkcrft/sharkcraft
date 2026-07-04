/**
 * Delegate ANALYSIS grounding (read-only, deterministic — NO model).
 *
 * An `analysis` delegate recipe grounds a local model's judgment on a
 * deterministic report the engine runs FIRST. This module:
 *   1. runs that report (`runGroundingReport`) and distils it to a compact
 *      summary + a set of known entities (files / constructs / reason codes);
 *   2. cross-checks the model's findings against those entities
 *      (`crossCheckFindings`) — a finding that cites an entity absent from the
 *      ground truth is flagged `unverified` (or dropped, in strict mode), so the
 *      model can prioritise/explain but never fabricate a fact;
 *   3. assembles the honest, advisory `IDelegateAnalysisReport`
 *      (`buildDelegateAnalysisReport`) — which NEVER writes.
 *
 * The model call itself happens in the cli orchestrator, not here (this layer is
 * pure). MCP surfaces only the grounding, never the model — see the safety model.
 */
import type { DelegateGroundingId } from '@shrkcrft/core';
import { buildTaskRiskReport, type IBuildTaskRiskOptions, type ITaskRiskReport } from './task-risk.ts';
import { analyzeTestImpact, type ITestImpact } from './test-impact.ts';
import { simulatePlan, type IPlanSimulationReport } from './plan-simulation.ts';
import { buildAgentBrief, type IAgentBrief } from './agent-brief.ts';
import * as nodePath from 'node:path';
import { buildUncertaintyReport, type IUncertaintyReport } from './uncertainty-report.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const DELEGATE_ANALYSIS_SCHEMA = 'sharkcraft.delegate-analysis/v1';

/** The deterministic ground truth an analysis recipe is checked against. */
export interface IGroundingFacts {
  groundedOn: string;
  /** Compact human-readable summary fed to the model as ground truth. */
  summary: string;
  /** Known entities (normalised references the model may legitimately cite). */
  entities: readonly string[];
  /** The underlying deterministic report (surfaced in `--json`). */
  raw: unknown;
}

/** One model finding, tagged by the deterministic cross-check. */
export interface IAnalysisFinding {
  id: string;
  message: string;
  /** Entities the model cited (explicit refs, or refs inferred from the message). */
  refs: readonly string[];
  /** True when the finding is anchored to ground truth (via refs or a message mention). */
  grounded: boolean;
  /** Cited refs NOT present in the ground truth. */
  unverifiedRefs: readonly string[];
}

/** The read-only advisory report an `analysis` recipe produces. */
export interface IDelegateAnalysisReport {
  schema: typeof DELEGATE_ANALYSIS_SCHEMA;
  generatedAt: string;
  recipeId: string;
  mode: 'analysis';
  groundedOn: string;
  task: string;
  /** Which provider produced the findings (`'none'` = deterministic-only). */
  provider: string;
  grounding: { summary: string; entityCount: number };
  findings: readonly IAnalysisFinding[];
  groundedCount: number;
  unverifiedCount: number;
  /** Optional free-form note from the model (informational, never grounded). */
  modelNote?: string;
  /** How many read-only query rounds the model ran (Phase 3 query loop). */
  queriesRun?: number;
  /** How many fan-out slices ran (Phase 4), when fan-out was used. */
  fanOutSlices?: number;
  /** Advisory escalation into a patch recipe, when the recipe declares escalateTo. */
  escalation?: { recipe: string; task: string; next: string };
  markdown: string;
  uncertainty: IUncertaintyReport;
}

function norm(s: string): string {
  // Strip surrounding delimiters/punctuation so a model that echoes a ground-truth
  // display form (`[intent-migration]`, `` `src/foo.ts` ``) still matches the bare
  // entity — otherwise a legitimate citation is falsely flagged `unverified`.
  return s
    .trim()
    .toLowerCase()
    .replace(/^[[\](){}`'"]+/, '')
    .replace(/[[\](){}`'".,;:]+$/, '');
}

function basename(s: string): string {
  const n = norm(s);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

function looksLikePath(s: string): boolean {
  return /[\/.]/.test(s) && /\.(ts|tsx|js|jsx|mjs|cjs|md|json|ya?ml)$/i.test(s.trim());
}

/** Distil a task-risk report into the entities a finding may legitimately cite. */
function groundingEntitiesFromTaskRisk(r: ITaskRiskReport): string[] {
  const out = new Set<string>();
  const add = (xs: readonly string[]) => {
    for (const x of xs) if (x && x.trim().length > 0) out.add(x.trim());
  };
  add(r.affectedFiles);
  add(r.highFanInFiles);
  add(r.highFanOutFiles);
  add(r.affectedConstructs);
  add(r.reasons.map((x) => x.code));
  add(r.ownershipGaps.filter(looksLikePath));
  return [...out];
}

/**
 * A layer-neutral snapshot of a failed delegate PATCH attempt — the ground truth
 * a `retry-analysis` recipe reasons over. Kept primitive (no dependency on the
 * cli-layer `IExecuteDelegateRunResult`) so the cli maps its result onto this and
 * the inspector grounds on it without an upward import.
 */
export interface IDelegateFailureContext {
  /** The failing status, e.g. `verify-failed` / `conflicts` / `guardrail-refused`. */
  status: string;
  message: string;
  conflicts?: readonly string[];
  commandsFailed?: readonly string[];
  refused?: readonly string[];
  droppedOps?: readonly { kind: string; targetPath: string }[];
  guardrailGlobs?: readonly string[];
  allowedOps?: readonly string[];
  /** 1-based attempt number this failure occurred on. */
  attempt?: number;
}

/** Options for `runGroundingReport` — task-risk knobs plus grounding payloads. */
export interface IRunGroundingOptions extends IBuildTaskRiskOptions {
  /** Required when grounding on `delegate-failure`. */
  failure?: IDelegateFailureContext;
  /** Required when grounding on `plan-simulation` — path to a saved plan. */
  planPath?: string;
}

/** The path in a `"path: reason"` conflict string (the citable entity). */
function conflictPath(c: string): string {
  const i = c.indexOf(':');
  return (i >= 0 ? c.slice(0, i) : c).trim();
}

/** Distil a delegate patch failure into ground truth for `retry-analysis`. */
export function buildDelegateFailureFacts(failure: IDelegateFailureContext): IGroundingFacts {
  const entities = new Set<string>();
  const add = (xs: readonly string[] | undefined) => {
    for (const x of xs ?? []) if (x && x.trim().length > 0) entities.add(x.trim());
  };
  add((failure.conflicts ?? []).map(conflictPath));
  add(failure.refused);
  add((failure.droppedOps ?? []).map((d) => d.targetPath));
  add(failure.commandsFailed);
  add(failure.allowedOps);
  entities.add(failure.status);

  const lines: string[] = [];
  lines.push(`Delegate patch attempt failed: ${failure.status}${failure.attempt ? ` (attempt ${failure.attempt})` : ''}.`);
  lines.push(`Message: ${failure.message}`);
  if (failure.conflicts?.length) lines.push(`Conflicts: ${failure.conflicts.join('; ')}.`);
  if (failure.commandsFailed?.length) lines.push(`Verification commands failed: ${failure.commandsFailed.join(', ')}.`);
  if (failure.refused?.length) lines.push(`Targets refused (outside guardrail globs): ${failure.refused.join(', ')}.`);
  if (failure.droppedOps?.length) {
    lines.push(`Ops dropped (kind not allowed): ${failure.droppedOps.map((d) => `${d.kind}→${d.targetPath}`).join(', ')}.`);
  }
  if (failure.allowedOps?.length) lines.push(`Only these op kinds are allowed: ${failure.allowedOps.join(', ')}.`);
  if (failure.guardrailGlobs?.length) lines.push(`Only these globs may be touched: ${failure.guardrailGlobs.join(', ')}.`);
  return { groundedOn: 'delegate-failure', summary: lines.join('\n'), entities: [...entities], raw: failure };
}

/** Entities + summary for grounding on the agent brief. */
function groundingFromAgentBrief(b: IAgentBrief): { summary: string; entities: string[] } {
  const entities = new Set<string>();
  if (b.taskRisk) {
    for (const f of b.taskRisk.affectedFiles) entities.add(f);
    for (const c of b.taskRisk.affectedConstructs) entities.add(c);
    for (const f of b.taskRisk.highFanInFiles) entities.add(f);
  }
  const risk = b.taskRisk ? `Risk: ${b.taskRisk.riskLevel} (score ${b.taskRisk.score}). ` : '';
  const summary = `Agent brief for: ${b.task}\n${risk}\n${b.markdown.slice(0, 1400)}`;
  return { summary, entities: [...entities].filter((x) => x.trim().length > 0) };
}

/** Entities a finding may cite when grounded on a test-impact report. */
function groundingEntitiesFromTestImpact(t: ITestImpact): string[] {
  const out = new Set<string>();
  const add = (xs: readonly string[]) => {
    for (const x of xs) if (x && x.trim().length > 0) out.add(x.trim());
  };
  add(t.inputFiles);
  add(t.likelyTestFiles);
  add(t.missingTestFiles);
  add(t.riskAreas);
  return [...out];
}

/** Entities a finding may cite when grounded on a plan simulation. */
function groundingEntitiesFromPlanSim(p: IPlanSimulationReport): string[] {
  const out = new Set<string>();
  const add = (xs: readonly string[]) => {
    for (const x of xs) if (x && x.trim().length > 0) out.add(x.trim());
  };
  add(p.files.map((f) => f.relativePath));
  add(p.affectedAreas);
  add(p.affectedConstructs);
  add(p.ownershipReviewFiles);
  add(p.likelyTests);
  return [...out];
}

/** A compact ground-truth summary of a plan simulation for the model prompt. */
function compactPlanSimSummary(p: IPlanSimulationReport): string {
  const lines: string[] = [];
  lines.push(`Plan: ${p.source} (${p.templateId ?? 'no-template'}), signature ${p.signature}, readiness ${p.applyReadiness}.`);
  if (p.files.length > 0) lines.push(`Files: ${p.files.map((f) => `${f.changeType} ${f.relativePath}`).slice(0, 12).join(', ')}.`);
  if (p.publicApiTouched) lines.push('Touches a public API surface.');
  if (p.ownershipReviewRequired) lines.push(`Ownership review required: ${p.ownershipReviewFiles.slice(0, 6).join(', ')}.`);
  if (p.potentialBoundaryConcerns.length > 0) lines.push(`Boundary concerns: ${p.potentialBoundaryConcerns.length}.`);
  if (p.policyConcerns.length > 0) lines.push(`Policy concerns: ${p.policyConcerns.slice(0, 6).join('; ')}.`);
  if (p.applyReadinessReasons.length > 0) lines.push(`Readiness reasons: ${p.applyReadinessReasons.slice(0, 6).join('; ')}.`);
  return lines.join('\n');
}

/** A compact ground-truth summary of a test-impact report for the model prompt. */
function compactTestImpactSummary(t: ITestImpact): string {
  const lines: string[] = [];
  lines.push(`Test impact for: ${t.task || '(repo)'} (confidence ${t.confidence}).`);
  if (t.likelyTestFiles.length > 0) lines.push(`Existing tests: ${t.likelyTestFiles.slice(0, 12).join(', ')}.`);
  if (t.missingTestFiles.length > 0) lines.push(`Missing tests (expected locations): ${t.missingTestFiles.slice(0, 12).join(', ')}.`);
  if (t.riskAreas.length > 0) lines.push(`Risk areas: ${t.riskAreas.slice(0, 8).join('; ')}.`);
  if (t.minimalCommands.length > 0) lines.push(`Minimal test command(s): ${t.minimalCommands.join(' ; ')}.`);
  return lines.join('\n');
}

/** A compact ground-truth summary for the model prompt (not the full report). */
function compactTaskRiskSummary(r: ITaskRiskReport): string {
  const lines: string[] = [];
  lines.push(`Task risk: ${r.riskLevel} (score ${r.score}), intent ${r.intent.kind}.`);
  lines.push(`Human approval required: ${r.humanApprovalRequired ? 'yes' : 'no'}.`);
  if (r.affectedFiles.length > 0) lines.push(`Affected files: ${r.affectedFiles.slice(0, 12).join(', ')}.`);
  if (r.highFanInFiles.length > 0) lines.push(`High fan-in: ${r.highFanInFiles.join(', ')}.`);
  if (r.boundaryConcerns.length > 0) lines.push(`Boundary concerns: ${r.boundaryConcerns.slice(0, 6).join('; ')}.`);
  if (r.policyConcerns.length > 0) lines.push(`Policy concerns: ${r.policyConcerns.slice(0, 6).join('; ')}.`);
  if (r.testGaps.length > 0) lines.push(`Test gaps: ${r.testGaps.slice(0, 6).join('; ')}.`);
  lines.push('Reasons:');
  for (const reason of r.reasons.slice(0, 12)) lines.push(`  - [${reason.code}] ${reason.message} (+${reason.weight})`);
  return lines.join('\n');
}

/**
 * Run the deterministic report an analysis recipe grounds on, distilled to a
 * compact summary + the entities a finding may legitimately cite. Read-only.
 */
export async function runGroundingReport(
  groundedOn: DelegateGroundingId | string,
  task: string,
  inspection: ISharkcraftInspection,
  options: IRunGroundingOptions = {},
): Promise<IGroundingFacts> {
  switch (groundedOn) {
    case 'task-risk': {
      const r = await buildTaskRiskReport(task, inspection, options);
      return {
        groundedOn,
        summary: compactTaskRiskSummary(r),
        entities: groundingEntitiesFromTaskRisk(r),
        raw: r,
      };
    }
    case 'test-impact': {
      const t = analyzeTestImpact(inspection, { task });
      return {
        groundedOn,
        summary: compactTestImpactSummary(t),
        entities: groundingEntitiesFromTestImpact(t),
        raw: t,
      };
    }
    case 'agent-brief': {
      const b = await buildAgentBrief(inspection, { task });
      const { summary, entities } = groundingFromAgentBrief(b);
      return { groundedOn, summary, entities, raw: b };
    }
    case 'plan-simulation': {
      // Grounded on a saved plan the cli supplies via `options.planPath`. Absent
      // it (or on a read error) there is nothing to critique.
      if (!options.planPath) {
        return { groundedOn, summary: '(plan-simulation grounding needs a --plan <path>)', entities: [], raw: null };
      }
      try {
        const abs = nodePath.isAbsolute(options.planPath)
          ? options.planPath
          : nodePath.resolve(inspection.projectRoot, options.planPath);
        const p = await simulatePlan(inspection, abs, { includeBoundaries: true, includeImpact: true, includeOwnership: true });
        return { groundedOn, summary: compactPlanSimSummary(p), entities: groundingEntitiesFromPlanSim(p), raw: p };
      } catch (e) {
        return { groundedOn, summary: `(could not simulate plan: ${(e as Error).message})`, entities: [], raw: null };
      }
    }
    case 'delegate-failure':
      // Grounded on a failed patch attempt — the cli supplies the failure via
      // `options.failure` (this grounding needs no inspection). Absent it, there
      // is nothing to reason over (e.g. a standalone MCP/CLI call with no failure).
      return options.failure
        ? buildDelegateFailureFacts(options.failure)
        : {
            groundedOn,
            summary: '(delegate-failure grounding needs a failure context — run it in the delegate retry loop)',
            entities: [],
            raw: null,
          };
    default:
      // Config validation gates `groundedOn` to a known id, so this is a
      // defensive fallback (empty ground truth ⇒ every claim is unverified).
      return { groundedOn, summary: `(no grounding runner for "${groundedOn}")`, entities: [], raw: null };
  }
}

export interface ICrossCheckOptions {
  /** Drop non-grounded findings instead of keeping+flagging them. */
  strict?: boolean;
}

export interface ICrossCheckResult {
  findings: IAnalysisFinding[];
  groundedCount: number;
  unverifiedCount: number;
}

/**
 * Cross-check model findings against the deterministic ground truth. A finding is
 * `grounded` when it cites ≥1 ref that all resolve to a report entity, OR — when
 * it cites no explicit refs — when its MESSAGE mentions a ground-truth entity
 * verbatim (models routinely state facts in prose without filling a refs array;
 * the live smoke showed exactly this). A claim anchored to nothing in the ground
 * truth stays unverified — judgment must ride on facts the model cannot fabricate.
 */
export function crossCheckFindings(
  rawFindings: readonly { id?: string; message: string; refs?: readonly string[] }[],
  facts: IGroundingFacts,
  options: ICrossCheckOptions = {},
): ICrossCheckResult {
  const entities = new Set(facts.entities.map(norm));
  const basenames = new Set(facts.entities.map(basename));
  const resolves = (ref: string): boolean => entities.has(norm(ref)) || basenames.has(basename(ref));
  // Entities long enough to match unambiguously inside prose (avoid noise from
  // very short codes). Matched case-insensitively as a substring of the message.
  const scannable = facts.entities.filter((e) => e.trim().length >= 4);
  const mentionedIn = (message: string): string[] => {
    const m = message.toLowerCase();
    const hits: string[] = [];
    for (const e of scannable) {
      const en = e.toLowerCase();
      const bn = basename(e);
      if (m.includes(en) || (bn.length >= 4 && m.includes(bn))) hits.push(e);
    }
    return hits;
  };
  const findings: IAnalysisFinding[] = [];
  let groundedCount = 0;
  let unverifiedCount = 0;
  for (let i = 0; i < rawFindings.length; i += 1) {
    const rf = rawFindings[i]!;
    const explicit = (rf.refs ?? []).map((r) => String(r));
    let refs = explicit;
    let unverifiedRefs = explicit.filter((r) => !resolves(r));
    let grounded = explicit.length > 0 && unverifiedRefs.length === 0;
    if (!grounded && explicit.length === 0) {
      // Fallback: the model stated facts in prose. Infer refs from the message.
      const inferred = mentionedIn(rf.message);
      if (inferred.length > 0) {
        refs = inferred;
        unverifiedRefs = [];
        grounded = true;
      }
    }
    if (options.strict && !grounded) {
      unverifiedCount += 1;
      continue; // dropped
    }
    findings.push({
      id: rf.id?.trim() || `finding-${i + 1}`,
      message: rf.message,
      refs,
      grounded,
      unverifiedRefs,
    });
    if (grounded) groundedCount += 1;
    else unverifiedCount += 1;
  }
  return { findings, groundedCount, unverifiedCount };
}

export interface IBuildAnalysisReportInput {
  recipeId: string;
  groundedOn: string;
  task: string;
  provider: string;
  facts: IGroundingFacts;
  crossCheck: ICrossCheckResult;
  modelNote?: string;
  /** True when no local model ran — the report is deterministic grounding only. */
  modelUnavailable?: boolean;
  /** Read-only query rounds the model ran (Phase 3), when the query loop was used. */
  queriesRun?: number;
  /** Fan-out slices that ran (Phase 4), when fan-out was used. */
  fanOutSlices?: number;
  /** A patch recipe this analysis may escalate to (Phase 4, advisory). */
  escalateTo?: string;
  generatedAt: string;
}

function buildAnalysisUncertainty(input: IBuildAnalysisReportInput): IUncertaintyReport {
  const { crossCheck, modelUnavailable } = input;
  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'medium';
  const reasons: string[] = [];
  const missing: { id: string; message: string }[] = [];
  if (modelUnavailable) {
    confidence = 'unknown';
    reasons.push('No local LLM reachable — deterministic grounding only, no judgment layer.');
    missing.push({ id: 'no-model', message: 'No local model produced findings.' });
  } else if (crossCheck.findings.length === 0) {
    confidence = 'low';
    reasons.push('The model returned no findings.');
  } else if (crossCheck.unverifiedCount > crossCheck.groundedCount) {
    confidence = 'low';
    reasons.push(
      `${crossCheck.unverifiedCount} of ${crossCheck.findings.length} finding(s) are unverified (cite entities absent from the ground truth).`,
    );
  }
  if (input.facts.entities.length === 0) {
    missing.push({ id: 'empty-grounding', message: 'The grounding report yielded no entities to check against.' });
  }
  return buildUncertaintyReport({
    confidence,
    reasons,
    missingSignals: missing,
    suggestedCommands: [`shrk risk "${input.task || '<task>'}"`, `shrk delegate explain ${input.recipeId}`],
    safeFallbackCommand: `shrk risk "${input.task || '<task>'}"`,
  });
}

function renderAnalysisMarkdown(input: IBuildAnalysisReportInput): string {
  const { crossCheck, facts } = input;
  const lines: string[] = [];
  lines.push(`# Delegate analysis — ${input.recipeId}`);
  lines.push('');
  lines.push(`- task: ${input.task || '(none)'}`);
  lines.push(`- grounded on: **${input.groundedOn}**`);
  lines.push(`- provider: ${input.provider}`);
  if (input.queriesRun !== undefined) lines.push(`- query rounds: ${input.queriesRun} (read-only fact-fetch loop)`);
  if (input.fanOutSlices !== undefined) lines.push(`- fan-out slices: ${input.fanOutSlices} (per-slice passes, merged)`);
  lines.push(`- findings: ${crossCheck.findings.length} (grounded ${crossCheck.groundedCount}, unverified ${crossCheck.unverifiedCount})`);
  lines.push('');
  lines.push('## Ground truth');
  lines.push('');
  lines.push(facts.summary);
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (crossCheck.findings.length === 0) {
    lines.push(input.modelUnavailable
      ? '_No local LLM reachable — deterministic grounding only. Start Ollama / set LLAMACPP_MODEL_PATH to add the judgment layer._'
      : '_(none)_');
  } else {
    for (const f of crossCheck.findings) {
      const tag = f.grounded ? '✓ grounded' : '⚠ unverified';
      lines.push(`- **[${tag}]** ${f.message}`);
      if (f.refs.length > 0) lines.push(`  - refs: ${f.refs.join(', ')}`);
      if (f.unverifiedRefs.length > 0) lines.push(`  - not in ground truth: ${f.unverifiedRefs.join(', ')}`);
    }
  }
  if (input.modelNote) {
    lines.push('');
    lines.push('## Model note (informational)');
    lines.push('');
    lines.push(input.modelNote);
  }
  const escalation = escalationHint(input);
  if (escalation) {
    lines.push('');
    lines.push('## Suggested escalation (advisory — you run it)');
    lines.push('');
    lines.push(`This gap can be handed to the patch recipe \`${escalation.recipe}\`:`);
    lines.push('```');
    lines.push(escalation.next);
    lines.push('```');
  }
  lines.push('');
  lines.push('---');
  lines.push('_Advisory, read-only — no write performed. Findings tagged `unverified` cite entities absent from the deterministic ground truth; treat them as hypotheses, not facts._');
  return lines.join('\n');
}

/** Assemble the honest, advisory analysis report. Never writes. */
export function buildDelegateAnalysisReport(input: IBuildAnalysisReportInput): IDelegateAnalysisReport {
  const report: IDelegateAnalysisReport = {
    schema: DELEGATE_ANALYSIS_SCHEMA,
    generatedAt: input.generatedAt,
    recipeId: input.recipeId,
    mode: 'analysis',
    groundedOn: input.groundedOn,
    task: input.task,
    provider: input.provider,
    grounding: { summary: input.facts.summary, entityCount: input.facts.entities.length },
    findings: input.crossCheck.findings,
    groundedCount: input.crossCheck.groundedCount,
    unverifiedCount: input.crossCheck.unverifiedCount,
    markdown: renderAnalysisMarkdown(input),
    uncertainty: buildAnalysisUncertainty(input),
  };
  if (input.modelNote) report.modelNote = input.modelNote;
  if (input.queriesRun !== undefined) report.queriesRun = input.queriesRun;
  if (input.fanOutSlices !== undefined) report.fanOutSlices = input.fanOutSlices;
  const escalation = escalationHint(input);
  if (escalation) report.escalation = escalation;
  return report;
}

/** Advisory next-command into a patch recipe, when findings warrant escalation. */
function escalationHint(input: IBuildAnalysisReportInput): { recipe: string; task: string; next: string } | undefined {
  if (!input.escalateTo) return undefined;
  const anchor = input.crossCheck.findings.find((f) => f.grounded) ?? input.crossCheck.findings[0];
  if (!anchor) return undefined;
  const task = anchor.message.slice(0, 120);
  return {
    recipe: input.escalateTo,
    task,
    next: `shrk delegate run "${task}" --recipe ${input.escalateTo} --apply`,
  };
}
