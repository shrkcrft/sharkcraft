/**
 * Role-specific views.
 * Task-aware extension — when a task is supplied, the view is
 * personalised using intent classification + task risk + intent's
 * suggested first command. No AI; deterministic.
 *
 * Read-only.
 */
import { classifyChangeIntent, ChangeIntentKind, type IChangeIntent } from './change-intent.ts';
import { buildTaskRiskReport, TaskRiskLevel, type ITaskRiskReport } from './task-risk.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const ROLE_VIEW_SCHEMA = 'sharkcraft.role-view/v1';

export enum RoleId {
  Developer = 'developer',
  Reviewer = 'reviewer',
  Architect = 'architect',
  ReleaseManager = 'release-manager',
  Security = 'security',
  AiAgent = 'ai-agent',
}

export interface IRoleView {
  schema: typeof ROLE_VIEW_SCHEMA;
  role: RoleId;
  title: string;
  description: string;
  topCommands: readonly string[];
  relevantReports: readonly string[];
  relevantRisks: readonly string[];
  suggestedNextAction: string;
}

export interface IRoleViewTaskSpecific {
  task: string;
  intentKind: ChangeIntentKind;
  intentConfidence: string;
  taskRiskLevel: TaskRiskLevel;
  taskCommands: readonly string[];
  taskRisks: readonly string[];
  taskReports: readonly string[];
  whatNotToDo: readonly string[];
  nextSafeAction: string;
  humanApprovalPoints: readonly string[];
}

export interface ITaskAwareRoleView extends IRoleView {
  taskSpecific?: IRoleViewTaskSpecific;
}

const VIEWS: readonly IRoleView[] = Object.freeze([
  {
    schema: ROLE_VIEW_SCHEMA,
    role: RoleId.Developer,
    title: 'Developer',
    description: 'Daily work loop — brief, dev session, plan, apply, validate.',
    topCommands: [
      'shrk brief "<task>"',
      'shrk dev start "<task>"',
      'shrk gen <templateId> <name> --dry-run --save-plan /tmp/plan.json',
      'shrk plan review /tmp/plan.json',
      'shrk apply /tmp/plan.json --verify-signature --validate',
      'shrk impact --since main',
      'shrk tests missing --since main',
    ],
    relevantReports: ['brief', 'impact', 'review packet', 'dev session report'],
    relevantRisks: ['Forgotten dry-run', 'Apply without --verify-signature'],
    suggestedNextAction: 'shrk brief "<your next task>"',
  },
  {
    schema: ROLE_VIEW_SCHEMA,
    role: RoleId.Reviewer,
    title: 'Reviewer',
    description: 'PR review surface — impact, ownership, policy, review packet.',
    topCommands: [
      'shrk review packet --v3 --since main',
      'shrk impact --since main',
      'shrk owners impact --since main',
      'shrk policy run',
      'shrk report site --output /tmp/site',
    ],
    relevantReports: ['review packet', 'impact', 'ownership', 'policy', 'report site'],
    relevantRisks: ['Hidden boundary change', 'Missing owners', 'Policy override without reason'],
    suggestedNextAction: 'shrk review packet --v3 --since main',
  },
  {
    schema: ROLE_VIEW_SCHEMA,
    role: RoleId.Architect,
    title: 'Architect',
    description: 'Architecture surface — map, boundaries, drift, constructs.',
    topCommands: [
      'shrk architecture map',
      'shrk check boundaries',
      'shrk drift',
      'shrk intelligence graph',
      'shrk constructs list',
    ],
    relevantReports: ['architecture map', 'drift report', 'boundary report', 'intelligence graph'],
    relevantRisks: ['Layer violations', 'Public-API drift', 'Untested constructs'],
    suggestedNextAction: 'shrk architecture map --risk',
  },
  {
    schema: ROLE_VIEW_SCHEMA,
    role: RoleId.ReleaseManager,
    title: 'Release manager',
    description: 'Release surface — readiness, smoke, preflight, changelog.',
    topCommands: [
      'shrk release readiness --strict',
      'shrk release smoke --scenario all',
      'shrk release smoke --matrix',
      'bun run release:preflight',
      'shrk install smoke --tarball',
    ],
    relevantReports: ['release readiness', 'release smoke', 'preflight'],
    relevantRisks: ['Stale preflight summary', 'Smoke regression', 'Tarball install failure'],
    suggestedNextAction: 'shrk release readiness --strict',
  },
  {
    schema: ROLE_VIEW_SCHEMA,
    role: RoleId.Security,
    title: 'Security',
    description: 'Safety surface — audit, compliance, policy, MCP no-write.',
    topCommands: [
      'shrk safety audit --deep',
      'shrk compliance check ai-safe-development',
      'shrk compliance check signed-pack-workflow',
      'shrk policy run --explain-overrides',
      'shrk packs doctor --release --require-signatures',
    ],
    relevantReports: ['safety audit', 'compliance report', 'policy report'],
    relevantRisks: ['MCP write tool introduced', 'Unsigned pack', 'Destructive demo line'],
    suggestedNextAction: 'shrk safety audit --deep',
  },
  {
    schema: ROLE_VIEW_SCHEMA,
    role: RoleId.AiAgent,
    title: 'AI agent',
    description: 'Agent-facing surface — brief, handoff, MCP tools, forbidden actions.',
    topCommands: [
      'shrk brief "<task>"',
      'shrk handoff "<task>"',
      'shrk orchestrate "<task>"',
      'shrk simulate "<task>"',
      'shrk intent "<task>"',
    ],
    relevantReports: ['brief', 'handoff', 'orchestration plan', 'workflow simulation'],
    relevantRisks: ['Auto-apply', 'MCP write attempt', 'Untracked pack command'],
    suggestedNextAction: 'shrk start-here',
  },
]);

export function listRoleViews(): readonly IRoleView[] {
  return VIEWS;
}

export function getRoleView(role: string): IRoleView | undefined {
  return VIEWS.find((v) => v.role === role);
}

const FORBIDDEN_FOR_RELEASE: readonly string[] = Object.freeze([
  'Do not publish or tag without explicit human approval.',
  'Do not skip preflight gates.',
]);

const FORBIDDEN_FOR_AI: readonly string[] = Object.freeze([
  'Do not call MCP write tools — MCP is read-only.',
  'Do not run `shrk apply` from MCP.',
  'Do not auto-apply plans.',
  'Do not execute pack-contributed verification commands without explicit local opt-in.',
]);

function buildTaskCommands(
  role: RoleId,
  intent: IChangeIntent,
  risk: ITaskRiskReport,
): { commands: string[]; risks: string[]; reports: string[]; forbidden: string[]; approvalPoints: string[] } {
  const commands: string[] = [];
  const risks: string[] = [];
  const reports: string[] = [];
  const forbidden: string[] = [];
  const approvalPoints: string[] = [];
  const t = JSON.stringify(intent.task);

  // Always start with a task brief
  commands.push(`shrk brief ${t}`);
  commands.push(`shrk intent ${t}`);

  // Per-role + intent
  switch (role) {
    case RoleId.Developer: {
      commands.push(`shrk dev start ${t}`);
      commands.push(`shrk gen <templateId> <name> --dry-run --save-plan /tmp/plan.json`);
      commands.push(`shrk plan review /tmp/plan.json`);
      if (intent.kind !== ChangeIntentKind.Docs) {
        commands.push(`shrk impact --since main`);
        commands.push(`shrk tests missing --since main`);
      }
      if (intent.kind === ChangeIntentKind.Bugfix) commands.push('shrk diagnostics suggest "<error text>"');
      reports.push('brief', 'task risk', 'impact', 'review packet');
      break;
    }
    case RoleId.Reviewer: {
      commands.push(`shrk review packet --v3 --since main`);
      commands.push(`shrk impact --since main`);
      commands.push(`shrk owners impact --since main`);
      commands.push(`shrk policy run --explain-overrides`);
      if (
        intent.kind === ChangeIntentKind.Architecture ||
        intent.domains.includes('boundaries') ||
        intent.domains.includes('plugin')
      ) {
        commands.push(`shrk architecture violations`);
      }
      if (intent.domains.includes('plugin') || intent.kind === ChangeIntentKind.Architecture) {
        commands.push('shrk api report --all --public-only');
      }
      reports.push('review packet', 'task risk', 'ownership', 'policy', 'architecture violations');
      break;
    }
    case RoleId.Architect: {
      commands.push('shrk architecture map --risk --signals');
      commands.push('shrk architecture violations');
      commands.push('shrk intelligence graph --include-imports');
      commands.push('shrk drift --json');
      if (intent.kind === ChangeIntentKind.Architecture || intent.domains.includes('boundaries')) {
        commands.push('shrk check boundaries --json');
      }
      reports.push('architecture map', 'task risk', 'drift report', 'intelligence graph');
      break;
    }
    case RoleId.ReleaseManager: {
      commands.push('shrk release readiness --strict');
      commands.push('shrk release smoke --scenario all');
      commands.push('shrk release smoke --matrix');
      commands.push('bun run release:preflight');
      if (intent.kind === ChangeIntentKind.Release) commands.push('shrk install smoke --tarball');
      reports.push('release readiness', 'release smoke', 'task risk', 'preflight');
      for (const f of FORBIDDEN_FOR_RELEASE) forbidden.push(f);
      break;
    }
    case RoleId.Security: {
      commands.push('shrk safety audit --deep');
      commands.push('shrk policy run --explain-overrides');
      commands.push('shrk compliance check ai-safe-development');
      if (intent.kind === ChangeIntentKind.Policy || intent.domains.includes('safety')) {
        commands.push('shrk compliance check signed-pack-workflow');
      }
      if (intent.kind === ChangeIntentKind.Release) commands.push('shrk packs doctor --release --require-signatures');
      reports.push('safety audit', 'task risk', 'compliance report', 'policy report');
      break;
    }
    case RoleId.AiAgent: {
      commands.push(`shrk handoff ${t}`);
      commands.push(`shrk orchestrate ${t} --risk-aware`);
      commands.push(`shrk simulate ${t} --mode conservative`);
      commands.push(`shrk recommend ${t}`);
      reports.push('brief', 'handoff', 'orchestration plan', 'task risk', 'workflow simulation');
      for (const f of FORBIDDEN_FOR_AI) forbidden.push(f);
      break;
    }
  }

  // Risk-driven extras
  if (risk.riskLevel === TaskRiskLevel.High || risk.riskLevel === TaskRiskLevel.Critical) {
    commands.push('shrk risk "' + intent.task + '" --explain');
    commands.push('shrk architecture map --risk --signals');
    commands.push('shrk policy run --explain-overrides');
    risks.push(`Task risk level is ${risk.riskLevel} (score ${risk.score}).`);
    approvalPoints.push('Risk review: a human must approve before any write step.');
  }
  for (const r of risk.reasons.slice(0, 5)) {
    risks.push(`[${r.code}] ${r.message}`);
  }
  for (const c of risk.boundaryConcerns) risks.push(c);
  for (const c of risk.policyConcerns) risks.push(c);
  for (const f of risk.ownershipGaps) risks.push(`Ownership gap: ${f}`);

  // Intent-required review
  if (intent.requiredHumanReview) {
    approvalPoints.push('Intent flagged as requiring human review.');
  }

  // Universal forbidden for AI/agent contexts when intent is release
  if (intent.kind === ChangeIntentKind.Release) {
    forbidden.push('Do not run a publish step without explicit human approval.');
    forbidden.push('Do not push tags from MCP.');
  }

  return {
    commands: [...new Set(commands)],
    risks: [...new Set(risks)],
    reports: [...new Set(reports)],
    forbidden: [...new Set(forbidden)],
    approvalPoints: [...new Set(approvalPoints)],
  };
}

export async function getTaskAwareRoleView(
  role: string,
  task: string,
  inspection: ISharkcraftInspection,
): Promise<ITaskAwareRoleView | undefined> {
  const base = getRoleView(role);
  if (!base) return undefined;
  const trimmed = task.trim();
  if (!trimmed) return { ...base };
  const intent = await classifyChangeIntent(trimmed, inspection);
  let risk: ITaskRiskReport;
  try {
    risk = await buildTaskRiskReport(trimmed, inspection, { includeMemory: true });
  } catch {
    return { ...base };
  }
  const composed = buildTaskCommands(base.role, intent, risk);
  const nextSafeAction =
    composed.commands[0] ?? intent.suggestedFirstCommand ?? base.suggestedNextAction;
  return {
    ...base,
    taskSpecific: {
      task: trimmed,
      intentKind: intent.kind,
      intentConfidence: intent.confidence,
      taskRiskLevel: risk.riskLevel,
      taskCommands: composed.commands.slice(0, 10),
      taskRisks: composed.risks.slice(0, 10),
      taskReports: composed.reports.slice(0, 10),
      whatNotToDo: composed.forbidden,
      nextSafeAction,
      humanApprovalPoints: composed.approvalPoints,
    },
  };
}

export function renderTaskAwareRoleViewText(v: ITaskAwareRoleView): string {
  const lines: string[] = [];
  lines.push(`=== Role view: ${v.title} ===`);
  lines.push(`  description     ${v.description}`);
  if (v.taskSpecific) {
    const t = v.taskSpecific;
    lines.push('');
    lines.push('--- Task-specific ---');
    lines.push(`  task            ${t.task}`);
    lines.push(`  intent          ${t.intentKind} (confidence ${t.intentConfidence})`);
    lines.push(`  task risk       ${t.taskRiskLevel}`);
    lines.push(`  next safe       ${t.nextSafeAction}`);
    if (t.taskCommands.length > 0) {
      lines.push('Top task commands:');
      for (const c of t.taskCommands) lines.push(`  $ ${c}`);
    }
    if (t.taskRisks.length > 0) {
      lines.push('Task risks:');
      for (const r of t.taskRisks) lines.push(`  • ${r}`);
    }
    if (t.taskReports.length > 0) {
      lines.push('Reports to consult: ' + t.taskReports.join(', '));
    }
    if (t.whatNotToDo.length > 0) {
      lines.push('What NOT to do:');
      for (const f of t.whatNotToDo) lines.push(`  • ${f}`);
    }
    if (t.humanApprovalPoints.length > 0) {
      lines.push('Human approval points:');
      for (const a of t.humanApprovalPoints) lines.push(`  • ${a}`);
    }
  } else {
    lines.push('Top commands:');
    for (const c of v.topCommands) lines.push(`  $ ${c}`);
    lines.push(`Suggested next: ${v.suggestedNextAction}`);
  }
  return lines.join('\n') + '\n';
}
