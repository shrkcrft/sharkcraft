import { analyzeImpact, type IImpactAnalysis } from './impact-analysis.ts';
import { buildCoverageReport } from './coverage-report.ts';
import { buildDriftReport } from './drift.ts';
import { buildTaskPacket } from './task-packet.ts';
import { compareQualityBaseline } from './quality-baseline.ts';
import { listConstructs, loadConstructs } from './construct-registry.ts';
import { listPlaybooks, loadPlaybooks, recommendPlaybooks } from './playbook-registry.ts';
import { scanDevSession } from './dev-session.ts';
import { readFeatureBundle } from './feature-bundle.ts';
import { buildTaskRiskReport, type ITaskRiskReport } from './task-risk.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const AGENT_BRIEF_SCHEMA = 'sharkcraft.agent-brief/v1';

export enum BriefMode {
  Compact = 'compact',
  Full = 'full',
  Review = 'review',
  Implementation = 'implementation',
  Handoff = 'handoff',
}

export interface IAgentBriefInput {
  task?: string;
  mode?: BriefMode;
  files?: readonly string[];
  since?: string;
  staged?: boolean;
  bundleId?: string;
  sessionId?: string;
  /** Optional path to a quality baseline JSON, for comparison. */
  qualityBaselineFile?: string;
  /** Cap on token-equivalent budget for the body. Default: 6000. */
  maxTokens?: number;
  /** When true, also produce chunked output via `chunks`. */
  chunked?: boolean;
  /**
   * Per-section budget (token-equivalent). Keys match section ids; values are
   * max tokens. Unknown keys are ignored.
   */
  sectionBudgets?: Record<string, number>;
}

export interface IAgentBriefSection {
  id: string;
  title: string;
  body: string;
}

export interface IAgentBriefChunk {
  /** Filename for the chunk (e.g. `01-task.md`). */
  file: string;
  /** Section id (matches IAgentBriefSection.id, or "index"). */
  sectionId: string;
  title: string;
  body: string;
  /** Token-equivalent estimate (chars/4). */
  tokenEstimate: number;
}

export interface IAgentBrief {
  schema: typeof AGENT_BRIEF_SCHEMA;
  task: string;
  mode: BriefMode;
  generatedAt: string;
  projectRoot: string;
  sections: readonly IAgentBriefSection[];
  /** Markdown serialization of the brief. */
  markdown: string;
  /** Top suggested next commands. */
  suggestedCommands: readonly string[];
  /** Optional impact summary if files/bundle/since produced one. */
  impact?: IImpactAnalysis;
  /** Per-task risk report when a task is provided. */
  taskRisk?: ITaskRiskReport;
  /** Source flags used to compute the brief. */
  inputs: {
    files: readonly string[];
    since: string | null;
    staged: boolean;
    bundleId: string | null;
    sessionId: string | null;
  };
  warnings: readonly string[];
  /** Token-equivalent estimate (chars/4) for the full markdown body. */
  totalTokenEstimate: number;
  /** Chunked output when input.chunked is true. */
  chunks?: readonly IAgentBriefChunk[];
}

const SAFETY_NOTE =
  'MCP is read-only. Use CLI for writes. Apply requires explicit human action.';

function inferMode(input: IAgentBriefInput): BriefMode {
  if (input.mode) return input.mode;
  const taskGiven = (input.task ?? '').trim().length > 0;
  const hasDiff = Boolean(input.since || input.staged || (input.files && input.files.length > 0));
  if (input.sessionId && !taskGiven) return BriefMode.Handoff;
  if (input.bundleId && !taskGiven) return BriefMode.Handoff;
  if (hasDiff && !taskGiven) return BriefMode.Review;
  return BriefMode.Implementation;
}

function clipMarkdown(md: string, maxTokens: number): string {
  // Rough token estimate: 4 chars per token.
  const maxChars = maxTokens * 4;
  if (md.length <= maxChars) return md;
  return md.slice(0, maxChars) + '\n\n_…truncated to respect maxTokens budget_\n';
}

function tokenEstimate(s: string): number {
  return Math.ceil(s.length / 4);
}

function trimSectionBody(body: string, maxTokens: number): string {
  const maxChars = Math.max(40, maxTokens * 4);
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars) + '\n\n_…section trimmed to respect section-budget._';
}

/** Chunk index ordering for stable file naming. */
const SECTION_ORDER = [
  'task',
  'project-overview',
  'rules',
  'paths',
  'templates',
  'pipeline',
  'action-hints',
  'forbidden',
  'impact',
  'boundary',
  'policy',
  'ownership',
  'coverage',
  'drift',
  'quality',
  'bundle',
  'session',
  'playbooks',
  'constructs',
  'suggested-commands',
  'safety',
];

async function gatherImpact(
  inspection: ISharkcraftInspection,
  input: IAgentBriefInput,
): Promise<IImpactAnalysis | null> {
  const files = [...(input.files ?? [])];
  const planTargets: string[] = [];
  if (input.bundleId) {
    const b = readFeatureBundle(inspection.projectRoot, input.bundleId);
    if (b) {
      for (const f of b.affectedFiles) files.push(f);
      for (const p of b.plans) for (const t of p.expectedTargets) planTargets.push(t);
    }
  }
  if (files.length === 0 && planTargets.length === 0 && !input.task) return null;
  return analyzeImpact(inspection, {
    ...(input.task ? { task: input.task } : {}),
    files,
    planTargets,
  });
}

function section(id: string, title: string, body: string): IAgentBriefSection {
  return { id, title, body };
}

function projectOverviewSection(inspection: ISharkcraftInspection): IAgentBriefSection {
  const ws = inspection.workspace;
  const lines: string[] = [];
  lines.push(`- **Name:** ${ws.packageName ?? '(unknown)'}`);
  const frameworks = (ws.frameworks ?? [])
    .map((f) => (typeof f === 'string' ? f : f.id ?? f.name ?? ''))
    .filter(Boolean);
  lines.push(`- **Frameworks:** ${frameworks.join(', ') || '(none detected)'}`);
  lines.push(`- **TypeScript:** ${ws.hasTypeScript ? 'yes' : 'no'}`);
  const pmRaw: unknown = ws.packageManager as unknown;
  const pm =
    typeof pmRaw === 'string'
      ? pmRaw
      : (pmRaw as { name?: string; version?: string } | undefined)?.name ?? '(unknown)';
  lines.push(`- **Package manager:** ${pm}`);
  const packs = inspection.packs.validPacks ?? [];
  lines.push(
    `- **Packs:** ${packs.length > 0 ? packs.map((p) => p.packageName).join(', ') : '(none)'}`,
  );
  return section('project-overview', 'Project overview', lines.join('\n'));
}

function rulesSection(packet: ReturnType<typeof buildTaskPacket>, limit: number): IAgentBriefSection {
  const lines: string[] = [];
  for (const r of packet.relevantRules.slice(0, limit)) {
    lines.push(`- **${r.id}**${r.title ? ` — ${r.title}` : ''}`);
  }
  if (lines.length === 0) lines.push('_No directly relevant rules._');
  return section('rules', 'Relevant rules', lines.join('\n'));
}

function pathsSection(
  packet: ReturnType<typeof buildTaskPacket>,
  limit: number,
): IAgentBriefSection {
  const lines: string[] = [];
  for (const p of packet.relevantPaths.slice(0, limit)) {
    lines.push(`- \`${p.id}\` ${p.title ? `— ${p.title}` : ''}`);
  }
  if (lines.length === 0) lines.push('_No path conventions matched._');
  return section('paths', 'Path conventions', lines.join('\n'));
}

function templatesSection(
  packet: ReturnType<typeof buildTaskPacket>,
  limit: number,
): IAgentBriefSection {
  const lines: string[] = [];
  for (const t of packet.relevantTemplates.slice(0, limit)) {
    lines.push(`- \`${t.id}\` — ${t.name ?? ''}`);
  }
  if (lines.length === 0) lines.push('_No templates matched._');
  return section('templates', 'Templates', lines.join('\n'));
}

function pipelineSection(packet: ReturnType<typeof buildTaskPacket>): IAgentBriefSection {
  const top = packet.recommendedPipelines[0];
  if (!top) return section('pipeline', 'Recommended pipeline', '_None recommended._');
  return section(
    'pipeline',
    'Recommended pipeline',
    `\`${top.pipelineId}\` — ${top.reason ?? 'best match by task ranker'}`,
  );
}

function actionHintsSection(packet: ReturnType<typeof buildTaskPacket>): IAgentBriefSection {
  const lines: string[] = [];
  const h = packet.actionHints;
  // h.commands is IActionHintCommand[] (objects with .command + optional
  // .purpose); h.mcpTools is IActionHintMcpTool[] (.tool + .purpose).
  // Earlier versions string-interpolated the whole object, producing
  // `- [object Object]` in the rendered brief.
  if (h.commands.length > 0) {
    lines.push('**Commands:**');
    for (const c of h.commands.slice(0, 5)) {
      const purpose = c.purpose ? ` — ${c.purpose}` : '';
      lines.push(`- \`${c.command}\`${purpose}`);
    }
  }
  if (h.mcpTools.length > 0) {
    lines.push('**MCP tools:**');
    for (const m of h.mcpTools.slice(0, 5)) {
      const purpose = m.purpose ? ` — ${m.purpose}` : '';
      lines.push(`- \`${m.tool}\`${purpose}`);
    }
  }
  if (h.verificationCommands.length > 0) {
    lines.push('**Verification:**');
    for (const v of h.verificationCommands.slice(0, 5)) lines.push(`- \`${v}\``);
  }
  if (lines.length === 0) lines.push('_No action hints surfaced._');
  return section('action-hints', 'Action hints', lines.join('\n'));
}

function forbiddenSection(packet: ReturnType<typeof buildTaskPacket>): IAgentBriefSection {
  const lines: string[] = [];
  if (packet.forbiddenActions.length === 0) lines.push('_None._');
  else for (const f of packet.forbiddenActions.slice(0, 12)) lines.push(`- ${f}`);
  return section('forbidden', 'Forbidden actions', lines.join('\n'));
}

function safetySection(): IAgentBriefSection {
  return section('safety', 'Safety', SAFETY_NOTE);
}

function impactSection(impact: IImpactAnalysis | null): IAgentBriefSection {
  if (!impact) return section('impact', 'Impact', '_No impact analysis available._');
  const lines: string[] = [];
  lines.push(`- **Risk:** ${impact.risk}`);
  lines.push(`- **Direct dependents:** ${impact.directDependents.length}`);
  lines.push(`- **Transitive dependents:** ${impact.transitiveDependents.length}`);
  lines.push(`- **Areas:** ${impact.affectedAreas.map((a) => a.id).slice(0, 4).join(', ') || '(none)'}`);
  if (impact.affectedTemplates.length > 0)
    lines.push(`- **Templates:** ${impact.affectedTemplates.map((t) => t.id).join(', ')}`);
  if (impact.affectedConstructs.length > 0)
    lines.push(`- **Constructs:** ${impact.affectedConstructs.map((c) => c.id).join(', ')}`);
  for (const r of impact.riskReasons.slice(0, 4)) lines.push(`  • ${r.code}: ${r.message}`);
  return section('impact', 'Impact', lines.join('\n'));
}

function ownershipSection(impact: IImpactAnalysis | null): IAgentBriefSection {
  if (!impact?.affectedOwnership) {
    return section('ownership', 'Ownership', '_No ownership data._');
  }
  const o = impact.affectedOwnership;
  const lines: string[] = [];
  if (o.owners.length > 0) lines.push(`- **Owners:** ${o.owners.join(', ')}`);
  if (o.reviewers.length > 0) lines.push(`- **Reviewers:** ${o.reviewers.join(', ')}`);
  if (o.requiredReviewFiles.length > 0) {
    lines.push(`- **Required review** on: ${o.requiredReviewFiles.slice(0, 5).join(', ')}`);
  }
  if (lines.length === 0) lines.push('_No ownership matches._');
  return section('ownership', 'Ownership', lines.join('\n'));
}

function policySection(impact: IImpactAnalysis | null): IAgentBriefSection {
  if (!impact || impact.affectedPolicies.length === 0) {
    return section('policy', 'Policy concerns', '_None detected._');
  }
  const lines: string[] = [];
  for (const p of impact.affectedPolicies) {
    lines.push(`- [${p.severity}] **${p.policyId}** — ${p.reason}`);
  }
  return section('policy', 'Policy concerns', lines.join('\n'));
}

function boundarySection(impact: IImpactAnalysis | null): IAgentBriefSection {
  if (!impact || impact.potentialBoundaryRisks.length === 0) {
    return section('boundary', 'Boundary concerns', '_None detected._');
  }
  const lines: string[] = [];
  for (const b of impact.potentialBoundaryRisks.slice(0, 6)) {
    lines.push(`- [${b.severity}] \`${b.ruleId}\` — ${b.reason}`);
  }
  return section('boundary', 'Boundary concerns', lines.join('\n'));
}

/**
 * Compute the deduplicated suggested-commands list. The result lands
 * in `IAgentBrief.suggestedCommands` (JSON contract preserved); a
 * markdown section is rendered ONLY if the list isn't already
 * covered by action-hints + verification (which it usually is — the
 * duplication was a major source of the ~100-line brief bloat).
 */
function suggestedCommandsSection(impact: IImpactAnalysis | null, packet: ReturnType<typeof buildTaskPacket>): {
  section: IAgentBriefSection | null;
  commands: string[];
} {
  const commands = new Set<string>();
  for (const c of impact?.suggestedTestCommands ?? []) commands.add(c);
  for (const c of impact?.suggestedValidationCommands ?? []) commands.add(c);
  for (const c of packet.recommendedCliCommands ?? []) commands.add(c);
  // Already-shown set: verification commands + action-hint commands
  // that are about to render in the actionHintsSection. Anything in
  // that set should NOT also appear in "Suggested commands".
  const alreadyShown = new Set<string>();
  for (const v of packet.actionHints.verificationCommands ?? []) alreadyShown.add(v);
  for (const c of packet.actionHints.commands ?? []) alreadyShown.add(c.command);
  const uniqueNew = [...commands].filter((c) => !alreadyShown.has(c));
  if (uniqueNew.length === 0) {
    return { section: null, commands: [...commands] };
  }
  const lines = uniqueNew.slice(0, 10).map((c) => `- \`${c}\``);
  return {
    section: section('suggested-commands', 'Suggested commands (not already listed above)', lines.join('\n')),
    commands: [...commands],
  };
}

async function bundleHandoffSection(
  inspection: ISharkcraftInspection,
  bundleId: string,
): Promise<IAgentBriefSection> {
  const b = readFeatureBundle(inspection.projectRoot, bundleId);
  if (!b) return section('bundle', 'Bundle handoff', `_Bundle "${bundleId}" not found._`);
  const lines: string[] = [];
  lines.push(`- **Bundle:** ${b.id}`);
  lines.push(`- **Status:** ${b.status}`);
  lines.push(`- **Risk:** ${b.riskLevel}`);
  lines.push(`- **Plans:** ${b.plans.length}`);
  lines.push(`- **Validations:** ${b.validations.length}`);
  lines.push(`- **Next:** ${b.nextAction ?? '(none)'}`);
  return section('bundle', 'Bundle handoff', lines.join('\n'));
}

async function sessionHandoffSection(
  inspection: ISharkcraftInspection,
  sessionId: string,
): Promise<IAgentBriefSection> {
  const load = scanDevSession(inspection.projectRoot, sessionId);
  if (!load) return section('session', 'Session handoff', `_Session "${sessionId}" not found._`);
  const state = load.state;
  const lines: string[] = [];
  lines.push(`- **Session:** ${load.id}`);
  lines.push(`- **Task:** ${load.task || '(none)'}`);
  lines.push(`- **Phase:** ${state?.phase ?? '(legacy)'}`);
  lines.push(`- **Plans:** ${state?.plans.length ?? 0}`);
  lines.push(`- **Applied:** ${state?.appliedPlans.length ?? 0}`);
  if (state?.nextAction) lines.push(`- **Next:** \`${state.nextAction}\``);
  return section('session', 'Session handoff', lines.join('\n'));
}

async function coverageSection(inspection: ISharkcraftInspection): Promise<IAgentBriefSection> {
  try {
    const cov = buildCoverageReport(inspection);
    const lines = [`- **Overall:** ${cov.overall}`];
    for (const c of cov.categories.slice(0, 5)) {
      lines.push(`- \`${c.id}\` ${c.score}`);
    }
    return section('coverage', 'Coverage', lines.join('\n'));
  } catch {
    return section('coverage', 'Coverage', '_unavailable_');
  }
}

async function driftSection(inspection: ISharkcraftInspection): Promise<IAgentBriefSection> {
  try {
    const d = buildDriftReport(inspection);
    return section(
      'drift',
      'Drift',
      `errors=${d.counts.error} warnings=${d.counts.warning} info=${d.counts.info}`,
    );
  } catch {
    return section('drift', 'Drift', '_unavailable_');
  }
}

async function qualitySection(
  inspection: ISharkcraftInspection,
  baselineFile?: string,
): Promise<IAgentBriefSection> {
  if (!baselineFile) return section('quality', 'Quality baseline', '_No baseline provided._');
  const cmp = await compareQualityBaseline(inspection, baselineFile);
  if (!cmp) return section('quality', 'Quality baseline', `_No baseline at ${baselineFile}._`);
  const lines = [
    `- **Baseline score:** ${cmp.baseline.qualityScore}`,
    `- **Current score:** ${cmp.current.qualityScore}`,
    `- **Regressions:** ${cmp.regressions.length}`,
    `- **Improvements:** ${cmp.improvements.length}`,
  ];
  return section('quality', 'Quality baseline', lines.join('\n'));
}

/**
 * Empty-section detector. A section is "empty" when its body is just
 * an italicized placeholder like `_None._` / `_No impact analysis
 * available._` / `_No ownership data._`. Suppressing these compresses
 * the typical brief from ~100 lines to ~40 — Claude doesn't need to
 * read "Policy concerns: _None detected._" to make a decision.
 */
function isEmptyBody(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return true;
  // Pure single-line italicized placeholder, e.g. `_None._` / `_No X data._`.
  return /^_[^_]+_$/.test(trimmed);
}

function sectionsToMarkdown(
  task: string,
  mode: BriefMode,
  sections: readonly IAgentBriefSection[],
): string {
  const lines: string[] = [];
  lines.push(`# SharkCraft brief: ${task || '(no task)'}`);
  lines.push('');
  // Mode only — timestamp adds noise to a "single page Claude reads
  // first" doc. The IAgentBrief.generatedAt field still carries it
  // for tooling that needs the timestamp.
  lines.push(`_Mode: \`${mode}\`_`);
  for (const s of sections) {
    if (isEmptyBody(s.body)) continue;
    lines.push('');
    lines.push(`## ${s.title}`);
    lines.push('');
    lines.push(s.body);
  }
  lines.push('');
  return lines.join('\n');
}

export async function buildAgentBrief(
  inspection: ISharkcraftInspection,
  input: IAgentBriefInput,
): Promise<IAgentBrief> {
  // Warm registries so impact / brief can include constructs / playbooks.
  await loadConstructs(inspection);
  await loadPlaybooks(inspection);
  const mode = inferMode(input);
  const task = (input.task ?? '').trim();
  const packet = buildTaskPacket(inspection, task || 'general project work', {
    maxTokens: 3500,
  });
  const impact = await gatherImpact(inspection, input);
  const sections: IAgentBriefSection[] = [];

  if (task) {
    sections.push(section('task', 'Task', task));
  }
  sections.push(projectOverviewSection(inspection));
  if (mode !== BriefMode.Compact) {
    sections.push(rulesSection(packet, 8));
    sections.push(pathsSection(packet, 8));
    sections.push(templatesSection(packet, 6));
    sections.push(pipelineSection(packet));
    sections.push(actionHintsSection(packet));
    sections.push(forbiddenSection(packet));
  } else {
    sections.push(rulesSection(packet, 4));
    sections.push(pathsSection(packet, 4));
    sections.push(templatesSection(packet, 4));
    sections.push(actionHintsSection(packet));
  }

  if (mode === BriefMode.Full || mode === BriefMode.Review) {
    sections.push(impactSection(impact));
    sections.push(boundarySection(impact));
    sections.push(policySection(impact));
    sections.push(ownershipSection(impact));
    sections.push(await coverageSection(inspection));
    sections.push(await driftSection(inspection));
    if (input.qualityBaselineFile)
      sections.push(await qualitySection(inspection, input.qualityBaselineFile));
  }

  if (mode === BriefMode.Implementation) {
    sections.push(impactSection(impact));
    sections.push(boundarySection(impact));
    sections.push(policySection(impact));
  }

  if (mode === BriefMode.Handoff) {
    if (input.bundleId) sections.push(await bundleHandoffSection(inspection, input.bundleId));
    if (input.sessionId) sections.push(await sessionHandoffSection(inspection, input.sessionId));
    sections.push(impactSection(impact));
  }

  // Playbook recommendation.
  if (task) {
    const playbooks = listPlaybooks(inspection);
    const recs = recommendPlaybooks(playbooks, task).slice(0, 3);
    if (recs.length > 0) {
      const lines = recs.map(
        (r) => `- \`${r.playbook.id}\` (${r.score}) — ${r.reasons.slice(0, 3).join(', ')}`,
      );
      sections.push(section('playbooks', 'Suggested playbooks', lines.join('\n')));
    }
  }

  // Construct hints when impact mentions any.
  if (impact && impact.affectedConstructs.length > 0) {
    const allConstructs = listConstructs(inspection);
    const lines = impact.affectedConstructs.map((c) => {
      const def = allConstructs.find((x) => x.id === c.id);
      return `- \`${c.id}\` (${c.type})${def?.description ? ` — ${def.description}` : ''}`;
    });
    sections.push(section('constructs', 'Affected constructs', lines.join('\n')));
  }

  // Always include suggested commands + safety.
  const { section: cmdSection, commands } = suggestedCommandsSection(impact, packet);
  // Only push when the section returns one — most briefs no longer
  // include this section because everything it would list is already
  // in action-hints / verification. The `commands` array still ships
  // in IAgentBrief.suggestedCommands for tooling that consumes it.
  if (cmdSection) sections.push(cmdSection);
  sections.push(safetySection());

  // Apply per-section budgets when requested.
  const trimmedSections: IAgentBriefSection[] =
    input.sectionBudgets && Object.keys(input.sectionBudgets).length > 0
      ? sections.map((s) => {
          const budget = input.sectionBudgets![s.id];
          if (typeof budget !== 'number' || budget <= 0) return s;
          return { ...s, body: trimSectionBody(s.body, budget) };
        })
      : sections;

  const markdown = clipMarkdown(
    sectionsToMarkdown(task || '(no task)', mode, trimmedSections),
    input.maxTokens ?? 6000,
  );

  const brief: IAgentBrief = {
    schema: AGENT_BRIEF_SCHEMA,
    task: task || '',
    mode,
    generatedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    sections: trimmedSections,
    markdown,
    suggestedCommands: commands,
    inputs: {
      files: input.files ?? [],
      since: input.since ?? null,
      staged: input.staged ?? false,
      bundleId: input.bundleId ?? null,
      sessionId: input.sessionId ?? null,
    },
    warnings: [],
    totalTokenEstimate: tokenEstimate(markdown),
  };
  if (impact) brief.impact = impact;

  // Attach a task-risk summary when a task is provided. Best-effort.
  if (task) {
    try {
      brief.taskRisk = await buildTaskRiskReport(task, inspection, {
        ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.staged ? { staged: true } : {}),
      });
    } catch {
      /* best-effort */
    }
  }

  if (input.chunked) {
    brief.chunks = buildBriefChunks(brief, trimmedSections);
  }
  return brief;
}

function buildBriefChunks(
  brief: IAgentBrief,
  sections: readonly IAgentBriefSection[],
): IAgentBriefChunk[] {
  const ordered = [...sections].sort((a, b) => {
    const ia = SECTION_ORDER.indexOf(a.id);
    const ib = SECTION_ORDER.indexOf(b.id);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const chunks: IAgentBriefChunk[] = [];
  const indexLines: string[] = [];
  indexLines.push(`# SharkCraft brief — index`);
  indexLines.push('');
  indexLines.push(`_Mode: \`${brief.mode}\` — ${brief.generatedAt}_`);
  if (brief.task) indexLines.push(`_Task: ${brief.task}_`);
  indexLines.push('');
  indexLines.push('Read the chunks in order:');
  for (let i = 0; i < ordered.length; i += 1) {
    const s = ordered[i]!;
    const idx = String(i + 1).padStart(2, '0');
    const file = `${idx}-${s.id}.md`;
    indexLines.push(`- [${s.title}](${file})`);
    const body = `# ${s.title}\n\n${s.body}\n\n---\n\n_Safety: MCP is read-only. Use CLI for writes. Apply requires explicit human action._\n`;
    chunks.push({
      file,
      sectionId: s.id,
      title: s.title,
      body,
      tokenEstimate: tokenEstimate(body),
    });
  }
  const indexBody = indexLines.join('\n') + '\n';
  chunks.unshift({
    file: '00-index.md',
    sectionId: 'index',
    title: 'Index',
    body: indexBody,
    tokenEstimate: tokenEstimate(indexBody),
  });
  return chunks;
}
