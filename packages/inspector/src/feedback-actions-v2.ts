/**
 * Feedback actions v2.
 *
 * Wraps the feedback-ingestion output into richer action / backlog /
 * prompt / plan shapes. The engine still does not auto-fix; humans pick
 * the recommended next commands.
 */
import {
  ingestFeedbackFile,
  FeedbackSeverity,
  type IFeedbackFinding,
} from './feedback-ingestion.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const FEEDBACK_ACTIONS_V2_SCHEMA = 'sharkcraft.feedback-actions/v2';

export enum FeedbackActionCategory {
  Good = 'good',
  Bad = 'bad',
  Missing = 'missing',
  Confusion = 'confusion',
  Friction = 'friction',
  Bug = 'bug',
  Feature = 'feature',
  Docs = 'docs',
  Safety = 'safety',
}

/**
 * Improvement classification: where the fix should land. The spec
 * asks for an explicit 4-bucket split, distinct from category (type of
 * feedback) and origin (where the feedback came from).
 */
export type FeedbackImprovementKind =
  | 'engine'        // ship a change in packages/**
  | 'pack'          // ship a change in a pack manifest / assets
  | 'local-config'  // ship a change in sharkcraft/<file>.ts
  | 'docs'          // ship a docs/markdown change
  | 'unknown';

export interface IFeedbackAction {
  readonly id: string;
  readonly originalExcerpt: string;
  readonly paraphrase?: string;
  readonly category: FeedbackActionCategory;
  readonly targetArea: string;
  readonly origin: 'engine-generic' | 'pack-specific' | 'project-specific' | 'unknown';
  /** Where the resulting fix should land. */
  readonly improvementKind: FeedbackImprovementKind;
  readonly severity: 'info' | 'minor' | 'major' | 'blocker';
  readonly priority: 'p0' | 'p1' | 'p2' | 'p3';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly recommendedCommands: readonly string[];
  readonly suggestedImplementationCategory: string;
  readonly suggestedTests: readonly string[];
  readonly alreadyCoveredBy?: string;
  readonly suggestedPromptSection?: string;
}

export interface IFeedbackActionsReport {
  readonly schema: typeof FEEDBACK_ACTIONS_V2_SCHEMA;
  readonly generatedAt: string;
  readonly sourceFile: string;
  readonly actions: readonly IFeedbackAction[];
}

export interface IFeedbackBacklogReport {
  readonly schema: 'sharkcraft.feedback-backlog/v1';
  readonly generatedAt: string;
  readonly grouped: Readonly<Record<string, readonly IFeedbackAction[]>>;
  readonly markdown: string;
}

export interface IFeedbackPromptReport {
  readonly schema: 'sharkcraft.feedback-prompt/v1';
  readonly generatedAt: string;
  readonly markdown: string;
}

export interface IFeedbackPlanReport {
  readonly schema: 'sharkcraft.feedback-plan/v1';
  readonly generatedAt: string;
  readonly orderedActions: readonly IFeedbackAction[];
  readonly validationGates: readonly string[];
}

function deriveCategory(tags: readonly string[] | undefined): FeedbackActionCategory {
  const t = (tags ?? []).map((x) => x.toLowerCase());
  if (t.some((x) => x === 'safety' || x === 'security')) return FeedbackActionCategory.Safety;
  if (t.some((x) => x === 'docs' || x === 'documentation')) return FeedbackActionCategory.Docs;
  if (t.some((x) => x === 'bug')) return FeedbackActionCategory.Bug;
  if (t.some((x) => x === 'missing' || x === 'gap')) return FeedbackActionCategory.Missing;
  if (t.some((x) => x === 'confusion' || x === 'unclear')) return FeedbackActionCategory.Confusion;
  if (t.some((x) => x === 'feature')) return FeedbackActionCategory.Feature;
  if (t.some((x) => x === 'good' || x === 'praise')) return FeedbackActionCategory.Good;
  if (t.some((x) => x === 'bad' || x === 'pain' || x === 'friction')) return FeedbackActionCategory.Friction;
  return FeedbackActionCategory.Friction;
}

function deriveOrigin(targetArea: string): IFeedbackAction['origin'] {
  if (/^pack|pack-/i.test(targetArea)) return 'pack-specific';
  if (/^engine|^shrk|^sharkcraft/i.test(targetArea)) return 'engine-generic';
  if (/^project|^local|^repo/i.test(targetArea)) return 'project-specific';
  return 'unknown';
}

function severityToString(sev: FeedbackSeverity): 'info' | 'minor' | 'major' | 'blocker' {
  if (sev === FeedbackSeverity.Blocker) return 'blocker';
  if (sev === FeedbackSeverity.Major) return 'major';
  if (sev === FeedbackSeverity.Minor) return 'minor';
  return 'info';
}

function derivePriority(severity: 'info' | 'minor' | 'major' | 'blocker'): IFeedbackAction['priority'] {
  if (severity === 'blocker') return 'p0';
  if (severity === 'major') return 'p1';
  if (severity === 'minor') return 'p2';
  return 'p3';
}

/**
 * Derive the four-bucket improvement kind from category + origin +
 * tags. The bucket says where the change must land, not the type of issue.
 */
function deriveImprovementKind(
  category: FeedbackActionCategory,
  origin: IFeedbackAction['origin'],
  tags: readonly string[],
): FeedbackImprovementKind {
  const t = tags.map((x) => x.toLowerCase());
  if (category === FeedbackActionCategory.Docs || t.some((x) => x === 'docs' || x === 'changelog')) {
    return 'docs';
  }
  if (origin === 'engine-generic') return 'engine';
  if (origin === 'pack-specific') return 'pack';
  if (origin === 'project-specific') return 'local-config';
  return 'unknown';
}

function findingToAction(finding: IFeedbackFinding, idx: number): IFeedbackAction {
  const severity = severityToString(finding.severity);
  const targetArea = finding.targetArea ?? 'unspecified';
  const category = deriveCategory(finding.tags);
  const origin = deriveOrigin(targetArea);
  return {
    id: `feedback.${idx + 1}.${targetArea.replace(/[^a-z0-9]+/gi, '-')}`,
    originalExcerpt: finding.text.slice(0, 200),
    paraphrase: finding.text.length > 200 ? finding.text.slice(0, 80) + '…' : finding.text,
    category,
    targetArea,
    origin,
    improvementKind: deriveImprovementKind(category, origin, finding.tags),
    severity,
    priority: derivePriority(severity),
    confidence: finding.tags.length >= 2 ? 'high' : finding.tags.length === 1 ? 'medium' : 'low',
    recommendedCommands: finding.suggestedCommands,
    suggestedImplementationCategory:
      finding.tags.some((t) => /template|scaffold/.test(t)) ? 'template'
      : finding.tags.some((t) => /docs|knowledge/.test(t)) ? 'docs'
      : finding.tags.some((t) => /test/.test(t)) ? 'tests'
      : 'manual',
    suggestedTests: [],
    suggestedPromptSection: `Follow up on "${targetArea}" — ${finding.text.slice(0, 120)}…`,
  };
}

export function buildFeedbackActionsReport(
  inspection: ISharkcraftInspection,
  sourceFile: string,
): IFeedbackActionsReport {
  const report = ingestFeedbackFile(inspection.projectRoot, sourceFile);
  return {
    schema: FEEDBACK_ACTIONS_V2_SCHEMA,
    generatedAt: new Date().toISOString(),
    sourceFile,
    actions: report.findings.map(findingToAction),
  };
}

export function buildFeedbackBacklogReport(
  inspection: ISharkcraftInspection,
  sourceFile: string,
): IFeedbackBacklogReport {
  const actions = buildFeedbackActionsReport(inspection, sourceFile).actions;
  const grouped: Record<string, IFeedbackAction[]> = { p0: [], p1: [], p2: [], p3: [] };
  for (const a of actions) grouped[a.priority]!.push(a);
  const lines: string[] = ['# Feedback backlog', '', `Source: \`${sourceFile}\``, ''];
  for (const p of ['p0', 'p1', 'p2', 'p3'] as const) {
    if (grouped[p]!.length === 0) continue;
    lines.push(`## ${p.toUpperCase()}`);
    for (const a of grouped[p]!) {
      lines.push(`- [ ] **${a.category}** (${a.origin}) — ${a.targetArea}`);
      lines.push(`      ${a.paraphrase ?? a.originalExcerpt.slice(0, 80)}…`);
      if (a.recommendedCommands.length > 0) {
        lines.push(`      next: ${a.recommendedCommands.join(' / ')}`);
      }
    }
    lines.push('');
  }
  return {
    schema: 'sharkcraft.feedback-backlog/v1',
    generatedAt: new Date().toISOString(),
    grouped,
    markdown: lines.join('\n') + '\n',
  };
}

export function buildFeedbackPromptReport(
  inspection: ISharkcraftInspection,
  sourceFile: string,
): IFeedbackPromptReport {
  const actions = buildFeedbackActionsReport(inspection, sourceFile).actions;
  const lines: string[] = ['# Implementation prompt', ''];
  lines.push(
    'The following sections were derived from real feedback. Implement them as separate parts; do not auto-apply.',
  );
  lines.push('');
  for (const a of actions) {
    lines.push(`## ${a.priority} ${a.targetArea} — ${a.category}`);
    if (a.suggestedPromptSection) lines.push(a.suggestedPromptSection);
    lines.push('');
    if (a.recommendedCommands.length > 0) {
      lines.push('**Suggested commands:**');
      for (const c of a.recommendedCommands) lines.push(`- \`${c}\``);
      lines.push('');
    }
  }
  return {
    schema: 'sharkcraft.feedback-prompt/v1',
    generatedAt: new Date().toISOString(),
    markdown: lines.join('\n') + '\n',
  };
}

export function buildFeedbackPlanReport(
  inspection: ISharkcraftInspection,
  sourceFile: string,
): IFeedbackPlanReport {
  const actions = buildFeedbackActionsReport(inspection, sourceFile).actions;
  const ordered = [...actions].sort((a, b) => a.priority.localeCompare(b.priority));
  return {
    schema: 'sharkcraft.feedback-plan/v1',
    generatedAt: new Date().toISOString(),
    orderedActions: ordered,
    validationGates: [
      'shrk doctor',
      'shrk self-config doctor',
      'shrk check boundaries --changed-only',
      'shrk safety audit --deep',
    ],
  };
}
