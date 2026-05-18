/**
 * Reusable agent-contract templates.
 *
 * `buildAgentContract` derives a contract from inspection + intent. Templates
 * are reusable starting points that capture *intent classes* — "release task",
 * "public-API change", "polyglot service change", etc. They are deterministic
 * dictionaries; rendering merges them with the live contract output.
 */
import {
  ContractFileRuleKind,
  ContractFileRuleSeverity,
  type IContractFileRule,
} from './contract-file-rule.ts';
import { RoleId } from './role-views.ts';
import { AgentContractMode } from './agent-contract.ts';

export const AGENT_CONTRACT_TEMPLATE_SCHEMA = 'sharkcraft.agent-contract-template/v1';

export enum AgentContractTemplateMatch {
  Exact = 'exact',
  Partial = 'partial',
  None = 'none',
}

export interface IAgentContractTemplateAppliesWhen {
  /** Lowercase substrings that should appear in the task. Any-of. */
  taskKeywords?: readonly string[];
  /** Intent kinds that should match (e.g. `release`, `migration`). */
  intentKinds?: readonly string[];
  /** Roles this template is intended for. */
  roles?: readonly RoleId[];
}

export interface IAgentContractTemplate {
  schema: typeof AGENT_CONTRACT_TEMPLATE_SCHEMA;
  id: string;
  title: string;
  description: string;
  role: RoleId;
  mode: AgentContractMode;
  defaultForbiddenFilesDetailed: readonly IContractFileRule[];
  defaultRequiredValidations: readonly string[];
  defaultHumanApprovalGates: readonly string[];
  defaultDefinitionOfDone: readonly string[];
  defaultRollbackPlan: readonly string[];
  appliesWhen: IAgentContractTemplateAppliesWhen;
}

const t = (input: Omit<IAgentContractTemplate, 'schema'>): IAgentContractTemplate => ({
  schema: AGENT_CONTRACT_TEMPLATE_SCHEMA,
  ...input,
});

const RULE_ERR = (pattern: string, kind: ContractFileRuleKind, reason: string): IContractFileRule => ({
  pattern,
  kind,
  reason,
  severity: ContractFileRuleSeverity.Error,
});

export const AI_AGENT_SAFE_CHANGE_TEMPLATE: IAgentContractTemplate = t({
  id: 'ai-agent-safe-change',
  title: 'AI agent — safe change',
  description: 'Baseline contract for an AI agent making a focused, low-blast-radius change.',
  role: RoleId.AiAgent,
  mode: AgentContractMode.Conservative,
  defaultForbiddenFilesDetailed: [
    RULE_ERR('.git/**', ContractFileRuleKind.Glob, 'Never write to git internals.'),
    RULE_ERR('.npmrc', ContractFileRuleKind.Exact, 'Registry credentials surface.'),
    RULE_ERR('package.json', ContractFileRuleKind.Exact, 'Do not bump version or change deps without approval.'),
    RULE_ERR('CHANGELOG.md', ContractFileRuleKind.Exact, 'Release manager approval required.'),
  ],
  defaultRequiredValidations: ['bun test', 'shrk doctor'],
  defaultHumanApprovalGates: ['Human approves before `shrk apply`.'],
  defaultDefinitionOfDone: [
    'Tests pass (`bun test`).',
    '`shrk doctor` is clean.',
    'No source-write happened from MCP.',
  ],
  defaultRollbackPlan: [
    'Revert the most recent `shrk apply` via `git revert <sha>`.',
    'Re-run `bun test` and `shrk doctor`.',
  ],
  appliesWhen: {
    roles: [RoleId.AiAgent],
  },
});

export const PUBLIC_API_CHANGE_TEMPLATE: IAgentContractTemplate = t({
  id: 'public-api-change',
  title: 'Public-API change',
  description: 'Contract for changes touching exported public surfaces / plugin-api.',
  role: RoleId.Developer,
  mode: AgentContractMode.Balanced,
  defaultForbiddenFilesDetailed: [
    RULE_ERR('packages/plugin-api/**/internal/**', ContractFileRuleKind.Glob, 'Never touch internal/* from a public-API change.'),
    RULE_ERR('.git/**', ContractFileRuleKind.Glob, 'Never write to git internals.'),
  ],
  defaultRequiredValidations: ['bun test', 'shrk doctor', 'shrk check boundaries', 'shrk api report --diff'],
  defaultHumanApprovalGates: [
    'API reviewer approves the surface diff before `shrk apply`.',
    'Update CHANGELOG.md with public-API change notes.',
  ],
  defaultDefinitionOfDone: [
    'API report is updated and reviewed.',
    'No removed/renamed exports without a deprecation notice.',
    'Boundary check passes.',
  ],
  defaultRollbackPlan: [
    'Revert the API change PR.',
    'Re-run `shrk api report --diff` to confirm clean surface.',
  ],
  appliesWhen: {
    taskKeywords: ['public api', 'plugin-api', 'exported', 'public surface'],
  },
});

export const RELEASE_TASK_TEMPLATE: IAgentContractTemplate = t({
  id: 'release-task',
  title: 'Release task',
  description: 'Contract for a release / publish flow. Forbids bypassing the gate.',
  role: RoleId.ReleaseManager,
  mode: AgentContractMode.Conservative,
  defaultForbiddenFilesDetailed: [
    RULE_ERR('package.json', ContractFileRuleKind.Exact, 'Bump version only inside `bun run release:bump-versions`.'),
    RULE_ERR('CHANGELOG.md', ContractFileRuleKind.Exact, 'Manual edits only after preflight passes.'),
    RULE_ERR('.npmrc', ContractFileRuleKind.Exact, 'Never commit registry credentials.'),
  ],
  defaultRequiredValidations: [
    'bun run release:preflight',
    'shrk release readiness --strict',
    'shrk safety audit --deep',
  ],
  defaultHumanApprovalGates: [
    'Release manager runs `bun run release:preflight` locally before tagging.',
    'Publish step is human-only (`bun run publish:packages`).',
  ],
  defaultDefinitionOfDone: [
    'Preflight is green.',
    'Readiness verdict is ready (strict).',
    'Tag pushed only after human verification.',
  ],
  defaultRollbackPlan: [
    'Delete the bad tag (`git tag -d` + `git push --delete`).',
    'Re-run preflight on the previous commit.',
  ],
  appliesWhen: {
    taskKeywords: ['release', 'publish', 'tag', 'cut a version', 'preflight'],
    intentKinds: ['release'],
    roles: [RoleId.ReleaseManager],
  },
});

export const MIGRATION_TASK_TEMPLATE: IAgentContractTemplate = t({
  id: 'migration-task',
  title: 'Migration task',
  description: 'Contract for a multi-step migration / refactor with explicit readiness gates.',
  role: RoleId.Developer,
  mode: AgentContractMode.Balanced,
  defaultForbiddenFilesDetailed: [
    RULE_ERR('package.json', ContractFileRuleKind.Exact, 'Do not bump dep versions mid-migration.'),
    RULE_ERR('.git/**', ContractFileRuleKind.Glob, 'Never write to git internals.'),
  ],
  defaultRequiredValidations: ['bun test', 'shrk doctor', 'shrk migration readiness'],
  defaultHumanApprovalGates: [
    'Migration readiness verdict must be "ready" before applying the migration plan.',
  ],
  defaultDefinitionOfDone: [
    'All migration steps reviewed.',
    'Readiness is ready.',
    'Tests + boundary check pass after each step.',
  ],
  defaultRollbackPlan: [
    'Revert the migration commit.',
    'Re-run `shrk migration readiness` to confirm rollback.',
  ],
  appliesWhen: {
    taskKeywords: ['migrate', 'migration', 'refactor', 'rename', 'rip out', 'retire'],
    intentKinds: ['migration', 'refactor'],
  },
});

export const SECURITY_SENSITIVE_CHANGE_TEMPLATE: IAgentContractTemplate = t({
  id: 'security-sensitive-change',
  title: 'Security-sensitive change',
  description: 'Contract for changes touching auth / signing / secrets / packs.',
  role: RoleId.Security,
  mode: AgentContractMode.Conservative,
  defaultForbiddenFilesDetailed: [
    RULE_ERR('.git/**', ContractFileRuleKind.Glob, 'Never write to git internals.'),
    RULE_ERR('.npmrc', ContractFileRuleKind.Exact, 'Registry credentials surface.'),
    RULE_ERR('**/manifest.signed.json', ContractFileRuleKind.Glob, 'Re-sign via `shrk packs sign`, never hand-edit.'),
    RULE_ERR('**/.env*', ContractFileRuleKind.Glob, 'Secrets must not be committed.'),
  ],
  defaultRequiredValidations: [
    'shrk safety audit --deep',
    'shrk packs doctor --require-signatures',
    'bun test',
  ],
  defaultHumanApprovalGates: [
    'Security reviewer approves changes to auth / signing / secrets / packs.',
    'Re-sign affected packs with the documented secret.',
  ],
  defaultDefinitionOfDone: [
    'Safety audit is green.',
    'Affected packs re-signed.',
    'No new write-style MCP tools.',
  ],
  defaultRollbackPlan: [
    'Revert the change PR.',
    'Re-sign packs with the previous secret.',
    'Re-run `shrk safety audit --deep`.',
  ],
  appliesWhen: {
    taskKeywords: ['auth', 'signing', 'sign', 'secret', 'pack', 'security', 'credentials', 'hmac'],
    roles: [RoleId.Security],
  },
});

export const POLYGLOT_SERVICE_CHANGE_TEMPLATE: IAgentContractTemplate = t({
  id: 'polyglot-service-change',
  title: 'Polyglot service change',
  description: 'Contract for changes in a repo with multiple language profiles (Java / C# / Python / Go / Rust + TS).',
  role: RoleId.Developer,
  mode: AgentContractMode.Balanced,
  defaultForbiddenFilesDetailed: [
    RULE_ERR('.git/**', ContractFileRuleKind.Glob, 'Never write to git internals.'),
    RULE_ERR('target/**', ContractFileRuleKind.Glob, 'Build outputs (Java/Rust) — should not be committed.'),
    RULE_ERR('bin/**', ContractFileRuleKind.Glob, 'Build outputs.'),
    RULE_ERR('obj/**', ContractFileRuleKind.Glob, '.NET build outputs.'),
    RULE_ERR('__pycache__/**', ContractFileRuleKind.Glob, 'Python bytecode cache.'),
    RULE_ERR('node_modules/**', ContractFileRuleKind.Glob, 'JS dep tree.'),
  ],
  defaultRequiredValidations: [
    'shrk languages detect',
    'shrk doctor',
    'shrk check boundaries',
  ],
  defaultHumanApprovalGates: [
    'Each language touched runs its native test suite (`mvn test` / `dotnet test` / `pytest` / `go test ./...` / `cargo test`).',
  ],
  defaultDefinitionOfDone: [
    'Each touched language profile has passing tests.',
    'Boundary check is green across languages.',
    'No bytecode / build outputs in the diff.',
  ],
  defaultRollbackPlan: [
    'Revert the change PR.',
    'Re-run language-native test suites for each touched language.',
  ],
  appliesWhen: {
    taskKeywords: ['java', 'maven', 'gradle', 'csharp', 'dotnet', 'python', 'pytest', 'golang', ' go ', 'rust', 'cargo', 'polyglot'],
  },
});

/**
 * Project-specific contract templates
 * now live in packs and are merged via `loadAllContractTemplates`. The
 * engine ships only generic templates here.
 */
export const ALL_CONTRACT_TEMPLATES: readonly IAgentContractTemplate[] = [
  AI_AGENT_SAFE_CHANGE_TEMPLATE,
  PUBLIC_API_CHANGE_TEMPLATE,
  RELEASE_TASK_TEMPLATE,
  MIGRATION_TASK_TEMPLATE,
  SECURITY_SENSITIVE_CHANGE_TEMPLATE,
  POLYGLOT_SERVICE_CHANGE_TEMPLATE,
];

export function listContractTemplates(): readonly IAgentContractTemplate[] {
  return ALL_CONTRACT_TEMPLATES;
}

export function getContractTemplate(id: string): IAgentContractTemplate | null {
  return ALL_CONTRACT_TEMPLATES.find((t) => t.id === id) ?? null;
}

export interface IContractTemplateMatchResult {
  template: IAgentContractTemplate;
  match: AgentContractTemplateMatch;
  reason: string;
}

/** Score each template against a task + optional role. Highest score wins. */
export function recommendContractTemplate(
  task: string,
  role?: RoleId,
  intentKind?: string,
): readonly IContractTemplateMatchResult[] {
  const lower = task.toLowerCase();
  const out: IContractTemplateMatchResult[] = [];
  for (const tpl of ALL_CONTRACT_TEMPLATES) {
    let score = 0;
    const reasons: string[] = [];
    const aw = tpl.appliesWhen;
    if (aw.taskKeywords && aw.taskKeywords.length > 0) {
      const hits = aw.taskKeywords.filter((k) => lower.includes(k.toLowerCase()));
      if (hits.length > 0) {
        score += hits.length * 2;
        reasons.push(`keyword: ${hits.join(', ')}`);
      }
    }
    if (aw.intentKinds && intentKind && aw.intentKinds.includes(intentKind)) {
      score += 3;
      reasons.push(`intent: ${intentKind}`);
    }
    if (aw.roles && role && aw.roles.includes(role)) {
      score += 2;
      reasons.push(`role: ${role}`);
    }
    if (score > 0) {
      const match = score >= 4 ? AgentContractTemplateMatch.Exact : AgentContractTemplateMatch.Partial;
      out.push({ template: tpl, match, reason: reasons.join('; ') });
    }
  }
  return out.sort((a, b) => (b.match === AgentContractTemplateMatch.Exact ? 1 : 0) - (a.match === AgentContractTemplateMatch.Exact ? 1 : 0));
}

export function renderContractTemplateMarkdown(t: IAgentContractTemplate, task?: string): string {
  let out = `# Contract template: ${t.title}\n\n`;
  if (task) out += `- **task**: ${task}\n`;
  out += `- **id**: \`${t.id}\`\n`;
  out += `- **role**: ${t.role}\n`;
  out += `- **mode**: ${t.mode}\n\n`;
  out += `${t.description}\n\n`;
  if (t.defaultForbiddenFilesDetailed.length > 0) {
    out += `## Forbidden files\n| Pattern | Kind | Reason |\n| --- | --- | --- |\n`;
    for (const r of t.defaultForbiddenFilesDetailed) out += `| \`${r.pattern}\` | ${r.kind} | ${r.reason ?? ''} |\n`;
    out += `\n`;
  }
  if (t.defaultRequiredValidations.length > 0) {
    out += `## Required validations\n`;
    for (const v of t.defaultRequiredValidations) out += `- \`${v}\`\n`;
    out += `\n`;
  }
  if (t.defaultHumanApprovalGates.length > 0) {
    out += `## Human approval gates\n`;
    for (const g of t.defaultHumanApprovalGates) out += `- ${g}\n`;
    out += `\n`;
  }
  if (t.defaultDefinitionOfDone.length > 0) {
    out += `## Definition of done\n`;
    for (const d of t.defaultDefinitionOfDone) out += `- ${d}\n`;
    out += `\n`;
  }
  if (t.defaultRollbackPlan.length > 0) {
    out += `## Rollback plan\n`;
    for (const r of t.defaultRollbackPlan) out += `- ${r}\n`;
    out += `\n`;
  }
  return out;
}

export function renderContractTemplateText(t: IAgentContractTemplate, task?: string): string {
  let out = `=== Contract template: ${t.title} ===\n`;
  if (task) out += `  task     ${task}\n`;
  out += `  id       ${t.id}\n`;
  out += `  role     ${t.role}\n`;
  out += `  mode     ${t.mode}\n\n`;
  out += `${t.description}\n\n`;
  if (t.defaultForbiddenFilesDetailed.length > 0) {
    out += `Forbidden files:\n`;
    for (const r of t.defaultForbiddenFilesDetailed) out += `  • [${r.kind}] ${r.pattern} — ${r.reason ?? ''}\n`;
    out += `\n`;
  }
  if (t.defaultRequiredValidations.length > 0) {
    out += `Required validations:\n`;
    for (const v of t.defaultRequiredValidations) out += `  • ${v}\n`;
    out += `\n`;
  }
  if (t.defaultHumanApprovalGates.length > 0) {
    out += `Human approval gates:\n`;
    for (const g of t.defaultHumanApprovalGates) out += `  • ${g}\n`;
    out += `\n`;
  }
  if (t.defaultDefinitionOfDone.length > 0) {
    out += `Definition of done:\n`;
    for (const d of t.defaultDefinitionOfDone) out += `  • ${d}\n`;
    out += `\n`;
  }
  if (t.defaultRollbackPlan.length > 0) {
    out += `Rollback plan:\n`;
    for (const r of t.defaultRollbackPlan) out += `  • ${r}\n`;
    out += `\n`;
  }
  return out;
}
