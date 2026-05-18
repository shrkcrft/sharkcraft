/**
 * Agent contract.
 *
 * Given a task, role, and mode, compose a deterministic safety contract
 * combining existing systems (intent, task risk, impact, ownership,
 * boundaries, policies, playbooks, constructs, templates, role views).
 *
 * Read-only. No model calls, no telemetry, no embeddings.
 */
import {
  classifyChangeIntent,
  ChangeIntentKind,
  type IChangeIntent,
} from './change-intent.ts';
import {
  buildTaskRiskReport,
  TaskRiskLevel,
  type ITaskRiskReport,
} from './task-risk.ts';
import { analyzeImpact, ImpactInputKind, type IImpactAnalysis } from './impact-analysis.ts';
import { loadOwnershipRules, impactFor as ownershipImpactFor } from './ownership.ts';
import { listPlaybooks, recommendPlaybooks } from './playbook-registry.ts';
import { listConstructs, loadConstructs } from './construct-registry.ts';
import { RoleId } from './role-views.ts';
import {
  ContractFileRuleKind,
  ContractFileRuleSeverity,
  type IContractFileRule,
} from './contract-file-rule.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const AGENT_CONTRACT_SCHEMA = 'sharkcraft.agent-contract/v1';

export enum AgentContractMode {
  Conservative = 'conservative',
  Balanced = 'balanced',
  Aggressive = 'aggressive',
}

export interface IBuildAgentContractOptions {
  files?: readonly string[];
  since?: string;
  staged?: boolean;
  role?: RoleId | string;
  mode?: AgentContractMode | string;
}

export interface IAgentContract {
  schema: typeof AGENT_CONTRACT_SCHEMA;
  generatedAt: string;
  task: string;
  intent: IChangeIntent;
  taskRisk: ITaskRiskReport;
  role: RoleId;
  mode: AgentContractMode;
  allowedFiles: readonly string[];
  forbiddenFiles: readonly string[];
  /** Structured file rules. Empty when contract only uses legacy strings. */
  allowedFilesDetailed?: readonly IContractFileRule[];
  forbiddenFilesDetailed?: readonly IContractFileRule[];
  allowedCommands: readonly string[];
  forbiddenCommands: readonly string[];
  requiredValidations: readonly string[];
  requiredReviews: readonly string[];
  requiredPlanReviews: readonly string[];
  humanApprovalGates: readonly string[];
  rollbackPlan: readonly string[];
  definitionOfDone: readonly string[];
  relevantConstructs: readonly string[];
  relevantPolicies: readonly string[];
  relevantBoundaries: readonly string[];
  relevantPlaybooks: readonly string[];
  relevantTemplates: readonly string[];
  likelyTests: readonly string[];
  impactedAreas: readonly string[];
  publicApiRisks: readonly string[];
  ownershipReview: readonly string[];
  recommendedNextCommand: string;
  safetyNotes: readonly string[];
}

const ROLE_FROM_STRING: ReadonlyMap<string, RoleId> = new Map([
  ['developer', RoleId.Developer],
  ['reviewer', RoleId.Reviewer],
  ['architect', RoleId.Architect],
  ['release-manager', RoleId.ReleaseManager],
  ['release', RoleId.ReleaseManager],
  ['security', RoleId.Security],
  ['ai-agent', RoleId.AiAgent],
  ['ai', RoleId.AiAgent],
]);

function resolveRole(input?: string | RoleId): RoleId {
  if (!input) return RoleId.Developer;
  const key = String(input).toLowerCase();
  return ROLE_FROM_STRING.get(key) ?? RoleId.Developer;
}

function resolveMode(input?: string | AgentContractMode): AgentContractMode {
  const v = String(input ?? '').toLowerCase();
  if (v === 'conservative') return AgentContractMode.Conservative;
  if (v === 'aggressive') return AgentContractMode.Aggressive;
  return AgentContractMode.Balanced;
}

function uniq<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}

function isPublicApiPath(file: string): boolean {
  return (
    file.endsWith('/index.ts') ||
    file.includes('plugin-api/') ||
    file.includes('public-api/')
  );
}

function isAdapterPath(file: string): boolean {
  return file.includes('/adapters/') || file.includes('adapter');
}

function isReleaseTask(intent: IChangeIntent): boolean {
  return intent.kind === ChangeIntentKind.Release;
}

function isMigrationTask(intent: IChangeIntent): boolean {
  return intent.kind === ChangeIntentKind.Migration;
}

function buildBoundaryHints(impact: IImpactAnalysis | null, files: readonly string[]): string[] {
  const out: string[] = [];
  if (impact) {
    for (const b of impact.potentialBoundaryRisks) {
      out.push(`${b.ruleId} — ${b.reason}`);
    }
  }
  for (const f of files) {
    if (isAdapterPath(f)) out.push(`adapter boundary likely touched (${f})`);
  }
  return uniq(out).slice(0, 10);
}

function buildPolicyHints(impact: IImpactAnalysis | null): string[] {
  if (!impact) return [];
  return uniq(impact.affectedPolicies.map((p) => `${p.policyId} — ${p.reason}`)).slice(0, 10);
}

function buildLikelyTests(impact: IImpactAnalysis | null): string[] {
  if (!impact) return [];
  return uniq(impact.likelyTests).slice(0, 10);
}

function buildImpactedAreas(impact: IImpactAnalysis | null): string[] {
  if (!impact) return [];
  const set = new Set<string>();
  for (const a of impact.affectedAreas ?? []) set.add(a.id);
  return [...set].slice(0, 10);
}

function buildPublicApiRisks(intent: IChangeIntent, files: readonly string[], impact: IImpactAnalysis | null): string[] {
  const out: string[] = [];
  const apiFiles = files.filter(isPublicApiPath);
  for (const f of apiFiles) out.push(`public API file touched: ${f}`);
  if (
    intent.domains.includes('plugin') &&
    (intent.kind === ChangeIntentKind.Architecture ||
      intent.kind === ChangeIntentKind.Feature ||
      intent.kind === ChangeIntentKind.Migration)
  ) {
    out.push('Plugin-api / public API may change — require API review.');
  }
  return uniq(out).slice(0, 10);
}

function buildOwnershipReview(impact: IImpactAnalysis | null): string[] {
  if (!impact) return [];
  const own = impact.affectedOwnership;
  const out: string[] = [];
  if (own && own.requiredReviewFiles.length > 0) {
    for (const f of own.requiredReviewFiles) out.push(f);
  }
  return uniq(out).slice(0, 10);
}

function buildForbiddenFiles(role: RoleId, intent: IChangeIntent): string[] {
  const out: string[] = [];
  // Releases and migrations: never auto-edit packaging or signature material.
  if (isReleaseTask(intent)) {
    out.push('package.json (do not bump version without explicit approval)');
    out.push('CHANGELOG.md (release manager approval required)');
  }
  // AI agent must never write to git internals or release-affecting files.
  if (role === RoleId.AiAgent) {
    out.push('.git/**');
    out.push('.npmrc');
    out.push('package.json (do not modify without explicit human approval)');
  }
  return uniq(out);
}

function buildForbiddenFilesDetailed(role: RoleId, intent: IChangeIntent): IContractFileRule[] {
  const out: IContractFileRule[] = [];
  if (isReleaseTask(intent)) {
    out.push({
      pattern: 'package.json',
      kind: ContractFileRuleKind.Exact,
      reason: 'Release task: do not bump version without explicit approval.',
      severity: ContractFileRuleSeverity.Error,
    });
    out.push({
      pattern: 'CHANGELOG.md',
      kind: ContractFileRuleKind.Exact,
      reason: 'Release manager approval required.',
      severity: ContractFileRuleSeverity.Error,
    });
  }
  if (role === RoleId.AiAgent) {
    out.push({
      pattern: '.git/**',
      kind: ContractFileRuleKind.Glob,
      reason: 'Never write to git internals.',
      severity: ContractFileRuleSeverity.Error,
    });
    out.push({
      pattern: '.npmrc',
      kind: ContractFileRuleKind.Exact,
      reason: 'Registry credentials surface.',
      severity: ContractFileRuleSeverity.Error,
    });
    out.push({
      pattern: 'package.json',
      kind: ContractFileRuleKind.Exact,
      reason: 'AI agent must not modify without explicit human approval.',
      severity: ContractFileRuleSeverity.Error,
    });
  }
  return out;
}

function buildAllowedFilesDetailed(
  files: readonly string[],
  intent: IChangeIntent,
): IContractFileRule[] {
  const out: IContractFileRule[] = [];
  for (const f of files) {
    if (isPublicApiPath(f)) continue;
    out.push({ pattern: f, kind: ContractFileRuleKind.Exact });
  }
  if (out.length === 0 && intent.likelyTemplates.length > 0) {
    // Allow generated files under common template targets.
    out.push({ pattern: 'packages/**', kind: ContractFileRuleKind.Glob });
  }
  return out;
}

function buildForbiddenCommands(role: RoleId, intent: IChangeIntent): string[] {
  const out: string[] = [
    'shrk apply <plan.json> --allow-divergent  (without explicit human approval)',
  ];
  if (isReleaseTask(intent) || isMigrationTask(intent)) {
    out.push('git push --tags');
    out.push('npm publish');
    out.push('bun publish');
  }
  if (role === RoleId.AiAgent) {
    out.push('Any MCP tool that writes (none exist; MCP is read-only).');
    out.push('shrk apply (auto-apply without human in the loop)');
    out.push('Pack-contributed verification commands (run via local CLI only).');
  }
  return uniq(out);
}

function buildAllowedCommands(role: RoleId, intent: IChangeIntent): string[] {
  const t = JSON.stringify(intent.task || '<task>');
  const out: string[] = [
    `shrk brief ${t}`,
    `shrk intent ${t}`,
    `shrk risk ${t} --include-memory`,
    `shrk impact --since main`,
    'shrk check boundaries',
  ];
  if (role === RoleId.AiAgent) {
    out.push(`shrk handoff ${t}`);
    out.push(`shrk orchestrate ${t} --mode conservative`);
    out.push(`shrk agent graph ${t} --role ai-agent`);
  }
  if (role === RoleId.Reviewer || role === RoleId.Architect) {
    out.push('shrk review packet --v3 --since main');
    out.push('shrk owners impact --since main');
    out.push('shrk policy run --explain-overrides');
  }
  if (role === RoleId.ReleaseManager) {
    out.push('shrk release readiness --strict');
    out.push('shrk release smoke --scenario all');
  }
  return uniq(out);
}

function buildRequiredValidations(intent: IChangeIntent, risk: ITaskRiskReport): string[] {
  const out = new Set<string>();
  out.add('bun x tsc -p tsconfig.base.json --noEmit');
  out.add('bun test');
  out.add('shrk doctor');
  out.add('shrk check boundaries');
  if (
    intent.kind === ChangeIntentKind.Architecture ||
    intent.domains.includes('boundaries')
  ) {
    out.add('shrk architecture violations');
  }
  if (risk.riskLevel === TaskRiskLevel.High || risk.riskLevel === TaskRiskLevel.Critical) {
    out.add('shrk policy run --explain-overrides');
    out.add('shrk safety audit --deep');
  }
  if (isReleaseTask(intent)) {
    out.add('bun run release:preflight');
    out.add('shrk release readiness --strict');
  }
  if (isMigrationTask(intent)) {
    out.add('shrk migration readiness');
  }
  return [...out];
}

function buildRequiredReviews(role: RoleId, intent: IChangeIntent, risk: ITaskRiskReport, hasPublicApi: boolean, hasAdapter: boolean): string[] {
  const out = new Set<string>();
  if (
    risk.riskLevel === TaskRiskLevel.High ||
    risk.riskLevel === TaskRiskLevel.Critical ||
    intent.requiredHumanReview
  ) {
    out.add('human review (risk-driven)');
  }
  if (hasPublicApi) out.add('API review (plugin-api / public-api change)');
  if (hasAdapter) out.add('adapter-boundary review');
  if (role === RoleId.AiAgent) {
    out.add('human in the loop — agent must NOT auto-apply');
  }
  return [...out];
}

function buildRequiredPlanReviews(intent: IChangeIntent): string[] {
  const lower = intent.task.toLowerCase();
  const out: string[] = [];
  if (
    lower.includes('plan') ||
    lower.includes('update operation') ||
    lower.includes('saved plan') ||
    intent.kind === ChangeIntentKind.Migration
  ) {
    out.push('shrk plan review <plan.json>');
    out.push('shrk plan simulate <plan.json> --include-boundaries --include-impact');
  }
  return out;
}

function buildHumanApprovalGates(
  role: RoleId,
  intent: IChangeIntent,
  risk: ITaskRiskReport,
  hasPublicApi: boolean,
): string[] {
  const out = new Set<string>();
  if (
    risk.riskLevel === TaskRiskLevel.High ||
    risk.riskLevel === TaskRiskLevel.Critical ||
    intent.requiredHumanReview
  ) {
    out.add('Approve before apply (risk-driven).');
  }
  if (isReleaseTask(intent)) {
    out.add('Approve before any publish / tag step.');
    out.add('Approve preflight result before tagging.');
  }
  if (isMigrationTask(intent)) {
    out.add('Approve migration readiness before applying.');
  }
  if (hasPublicApi) out.add('Approve any public-API change explicitly.');
  if (role === RoleId.AiAgent) out.add('Human runs the apply step; agent never auto-applies.');
  return [...out];
}

function buildRollbackPlan(intent: IChangeIntent): string[] {
  const out: string[] = [
    'git restore -SW <changed files>  (before commit)',
    'git revert <commit-sha>          (after commit)',
  ];
  if (isReleaseTask(intent)) {
    out.push('npm unpublish (within 72h) only with explicit authorization.');
    out.push('Tag rollback: do not force-push; cut a follow-up release instead.');
  }
  return out;
}

function buildDefinitionOfDone(intent: IChangeIntent, validations: readonly string[]): string[] {
  const out: string[] = [
    'All listed validations pass.',
    'No new boundary violations.',
    'Plan was reviewed and applied via CLI (not MCP).',
  ];
  if (intent.kind !== ChangeIntentKind.Docs) {
    out.push('Tests cover new public surfaces.');
  }
  if (isReleaseTask(intent)) {
    out.push('CHANGELOG entry exists; preflight is green.');
  }
  if (validations.includes('shrk migration readiness')) {
    out.push('Migration readiness verdict is "ready".');
  }
  return out;
}

function buildAllowedFiles(files: readonly string[], intent: IChangeIntent): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (isPublicApiPath(f)) continue;
    out.push(f);
  }
  if (out.length === 0 && intent.likelyTemplates.length > 0) {
    out.push('(target files derived from chosen template at gen time)');
  }
  return uniq(out);
}

function buildSafetyNotes(role: RoleId, intent: IChangeIntent, risk: ITaskRiskReport): string[] {
  const out: string[] = [
    'MCP is read-only — never call write-style MCP tools (none exist).',
    'CLI is the only write path. Apply requires --verify-signature for signed plans.',
  ];
  if (role === RoleId.AiAgent) {
    out.push('Agent contract requires explicit human approval before apply.');
    out.push('Always run shrk handoff / shrk brief before first action.');
  }
  if (risk.riskLevel === TaskRiskLevel.High || risk.riskLevel === TaskRiskLevel.Critical) {
    out.push(`Risk level is ${risk.riskLevel} — extra approval required.`);
  }
  if (isReleaseTask(intent)) {
    out.push('Release work must not auto-publish; preflight + readiness required.');
  }
  return out;
}

function buildRecommendedNextCommand(role: RoleId, intent: IChangeIntent): string {
  const t = JSON.stringify(intent.task || '<task>');
  if (role === RoleId.AiAgent) return `shrk handoff ${t}`;
  if (role === RoleId.ReleaseManager) return 'shrk release readiness --strict';
  if (role === RoleId.Security) return 'shrk safety audit --deep';
  if (role === RoleId.Architect) return 'shrk architecture map --risk --signals';
  if (role === RoleId.Reviewer) return 'shrk review packet --v3 --since main';
  return `shrk brief ${t}`;
}

export async function buildAgentContract(
  task: string,
  inspection: ISharkcraftInspection,
  options: IBuildAgentContractOptions = {},
): Promise<IAgentContract> {
  const trimmed = (task || '').trim();
  const role = resolveRole(options.role);
  const mode = resolveMode(options.mode);

  const intent = await classifyChangeIntent(trimmed, inspection);
  const risk = await buildTaskRiskReport(trimmed, inspection, {
    ...(options.files ? { files: options.files } : {}),
    ...(options.since ? { since: options.since } : {}),
    ...(options.staged ? { staged: true } : {}),
    includeMemory: true,
  });

  let impact: IImpactAnalysis | null = null;
  try {
    const impactInput: { task: string; files?: readonly string[]; inputKind: ImpactInputKind } = {
      task: trimmed,
      inputKind: (options.files && options.files.length > 0) ? ImpactInputKind.Files : ImpactInputKind.Task,
    };
    if (options.files && options.files.length > 0) impactInput.files = options.files;
    impact = await analyzeImpact(inspection, impactInput);
  } catch {
    impact = null;
  }

  // Make sure ownership rules are loaded so risk.ownershipGaps has context.
  try {
    await loadOwnershipRules(inspection.projectRoot);
  } catch {
    /* best-effort */
  }
  void ownershipImpactFor; // referenced for future direct calls

  await loadConstructs(inspection);
  const constructList = listConstructs(inspection) ?? [];
  const playbooks = await listPlaybooks(inspection);
  const recommended = recommendPlaybooks(playbooks, trimmed);

  const files = options.files ?? risk.affectedFiles;
  const hasAdapter = files.some(isAdapterPath);
  const hasPublicApi = files.some(isPublicApiPath);

  const allowedCommands = buildAllowedCommands(role, intent);
  const forbiddenCommands = buildForbiddenCommands(role, intent);
  const allowedFiles = buildAllowedFiles(files, intent);
  const forbiddenFiles = buildForbiddenFiles(role, intent);
  const allowedFilesDetailed = buildAllowedFilesDetailed(files, intent);
  const forbiddenFilesDetailed = buildForbiddenFilesDetailed(role, intent);
  const requiredValidations = buildRequiredValidations(intent, risk);
  const requiredReviews = buildRequiredReviews(role, intent, risk, hasPublicApi, hasAdapter);
  const requiredPlanReviews = buildRequiredPlanReviews(intent);
  const humanApprovalGates = buildHumanApprovalGates(role, intent, risk, hasPublicApi);
  const rollbackPlan = buildRollbackPlan(intent);
  const definitionOfDone = buildDefinitionOfDone(intent, requiredValidations);
  const safetyNotes = buildSafetyNotes(role, intent, risk);
  const recommendedNextCommand = buildRecommendedNextCommand(role, intent);

  const relevantConstructs = uniq([
    ...intent.likelyConstructs,
    ...risk.affectedConstructs,
    ...constructList
      .filter((c) => trimmed.toLowerCase().includes(c.id.toLowerCase()))
      .map((c) => c.id),
  ]).slice(0, 12);

  const relevantPlaybooks = recommended.slice(0, 5).map((r) => r.playbook.id);
  const relevantTemplates = intent.likelyTemplates.slice(0, 10);
  const relevantPolicies = buildPolicyHints(impact);
  const relevantBoundaries = buildBoundaryHints(impact, files);
  const likelyTests = buildLikelyTests(impact);
  const impactedAreas = buildImpactedAreas(impact);
  const publicApiRisks = buildPublicApiRisks(intent, files, impact);
  const ownershipReview = buildOwnershipReview(impact);

  return {
    schema: AGENT_CONTRACT_SCHEMA,
    generatedAt: new Date().toISOString(),
    task: trimmed,
    intent,
    taskRisk: risk,
    role,
    mode,
    allowedFiles,
    forbiddenFiles,
    allowedFilesDetailed,
    forbiddenFilesDetailed,
    allowedCommands,
    forbiddenCommands,
    requiredValidations,
    requiredReviews,
    requiredPlanReviews,
    humanApprovalGates,
    rollbackPlan,
    definitionOfDone,
    relevantConstructs,
    relevantPolicies,
    relevantBoundaries,
    relevantPlaybooks,
    relevantTemplates,
    likelyTests,
    impactedAreas,
    publicApiRisks,
    ownershipReview,
    recommendedNextCommand,
    safetyNotes,
  };
}

function listLines(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return `${title}:\n${items.map((i) => `  • ${i}`).join('\n')}\n\n`;
}

export function renderAgentContractText(c: IAgentContract): string {
  let out = `=== Agent contract ===\n`;
  out += `  task     ${c.task || '(empty)'}\n`;
  out += `  intent   ${c.intent.kind} / ${c.intent.confidence}\n`;
  out += `  role     ${c.role}\n`;
  out += `  mode     ${c.mode}\n`;
  out += `  risk     ${c.taskRisk.riskLevel} (score ${c.taskRisk.score})\n`;
  out += `  approval ${c.taskRisk.humanApprovalRequired ? 'REQUIRED' : 'not required by risk gate'}\n\n`;
  out += listLines('Allowed files', c.allowedFiles);
  out += listLines('Forbidden files', c.forbiddenFiles);
  out += listLines('Allowed commands', c.allowedCommands);
  out += listLines('Forbidden commands', c.forbiddenCommands);
  out += listLines('Required validations', c.requiredValidations);
  out += listLines('Required reviews', c.requiredReviews);
  out += listLines('Required plan reviews', c.requiredPlanReviews);
  out += listLines('Human approval gates', c.humanApprovalGates);
  out += listLines('Rollback plan', c.rollbackPlan);
  out += listLines('Definition of done', c.definitionOfDone);
  out += listLines('Relevant constructs', c.relevantConstructs);
  out += listLines('Relevant policies', c.relevantPolicies);
  out += listLines('Relevant boundaries', c.relevantBoundaries);
  out += listLines('Relevant playbooks', c.relevantPlaybooks);
  out += listLines('Relevant templates', c.relevantTemplates);
  out += listLines('Likely tests', c.likelyTests);
  out += listLines('Impacted areas', c.impactedAreas);
  out += listLines('Public API risks', c.publicApiRisks);
  out += listLines('Ownership review', c.ownershipReview);
  out += listLines('Safety notes', c.safetyNotes);
  out += `Recommended next command:\n  $ ${c.recommendedNextCommand}\n`;
  return out;
}

function mdList(title: string, items: readonly string[]): string {
  if (items.length === 0) return '';
  return `## ${title}\n${items.map((i) => `- ${i}`).join('\n')}\n\n`;
}

export function renderAgentContractMarkdown(c: IAgentContract): string {
  let out = `# Agent contract\n\n`;
  out += `- **task**: ${c.task || '(empty)'}\n`;
  out += `- **intent**: ${c.intent.kind} (${c.intent.confidence})\n`;
  out += `- **role**: ${c.role}\n`;
  out += `- **mode**: ${c.mode}\n`;
  out += `- **risk**: ${c.taskRisk.riskLevel} (score ${c.taskRisk.score})\n`;
  out += `- **approval**: ${c.taskRisk.humanApprovalRequired ? 'REQUIRED' : 'not required by risk gate'}\n`;
  out += `- **generated**: ${c.generatedAt}\n\n`;
  out += mdList('Allowed files', c.allowedFiles);
  out += mdList('Forbidden files', c.forbiddenFiles);
  out += mdList('Allowed commands', c.allowedCommands);
  out += mdList('Forbidden commands', c.forbiddenCommands);
  out += mdList('Required validations', c.requiredValidations);
  out += mdList('Required reviews', c.requiredReviews);
  out += mdList('Required plan reviews', c.requiredPlanReviews);
  out += mdList('Human approval gates', c.humanApprovalGates);
  out += mdList('Rollback plan', c.rollbackPlan);
  out += mdList('Definition of done', c.definitionOfDone);
  out += mdList('Relevant constructs', c.relevantConstructs);
  out += mdList('Relevant policies', c.relevantPolicies);
  out += mdList('Relevant boundaries', c.relevantBoundaries);
  out += mdList('Relevant playbooks', c.relevantPlaybooks);
  out += mdList('Relevant templates', c.relevantTemplates);
  out += mdList('Likely tests', c.likelyTests);
  out += mdList('Impacted areas', c.impactedAreas);
  out += mdList('Public API risks', c.publicApiRisks);
  out += mdList('Ownership review', c.ownershipReview);
  out += mdList('Safety notes', c.safetyNotes);
  out += `**Recommended next command**: \`${c.recommendedNextCommand}\`\n`;
  return out;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderAgentContractHtml(c: IAgentContract): string {
  const md = renderAgentContractMarkdown(c);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Agent contract</title></head><body><pre>${htmlEscape(md)}</pre></body></html>\n`;
}
