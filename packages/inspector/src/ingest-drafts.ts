import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  renderRepositoryKnowledgeModelJson,
  renderRepositoryKnowledgeModelMarkdown,
  type IRepositoryKnowledgeModel,
} from './repository-knowledge-model.ts';
import { renderGeneratedCodeReportMarkdown } from './generated-code.ts';
import { renderContradictionReportMarkdown } from './contradictions.ts';
import { renderStabilityMapMarkdown } from './stability-map.ts';

export interface IWrittenIngestFile {
  path: string;
  bytes: number;
}

export interface IWriteIngestDraftsOptions {
  projectRoot: string;
  /** Override the output directory. Default: `<projectRoot>/sharkcraft/ingestion`. */
  outDir?: string;
}

export interface IWriteIngestDraftsResult {
  outDir: string;
  files: readonly IWrittenIngestFile[];
}

export function writeIngestDrafts(
  model: IRepositoryKnowledgeModel,
  options: IWriteIngestDraftsOptions,
): IWriteIngestDraftsResult {
  const outDir = nodePath.resolve(
    options.outDir ?? nodePath.join(options.projectRoot, 'sharkcraft', 'ingestion'),
  );
  ensureDir(outDir);
  const files: IWrittenIngestFile[] = [];
  const write = (relName: string, body: string): void => {
    const full = nodePath.join(outDir, relName);
    if (!full.startsWith(outDir + nodePath.sep)) {
      throw new Error(`draft path escapes outDir: ${relName}`);
    }
    ensureDir(nodePath.dirname(full));
    writeFileSync(full, body, 'utf8');
    files.push({ path: full, bytes: Buffer.byteLength(body, 'utf8') });
  };

  // 1) Main JSON model.
  write('repository-knowledge-model.json', renderRepositoryKnowledgeModelJson(model));

  // 2) Per-section markdown summaries.
  write('REPO_OVERVIEW.md', renderRepoOverviewMarkdown(model));
  write('ARCHITECTURE_MODEL.md', renderArchitectureMarkdown(model));
  write('BUSINESS_LOGIC_MODEL.md', renderBusinessLogicMarkdown(model));
  write('RULES_AND_CONVENTIONS.md', renderRulesMarkdown(model));
  write('DEPENDENCY_BOUNDARIES.md', renderBoundariesMarkdown(model));
  write('DOMAIN_MAP.md', renderDomainMapMarkdown(model));
  write('WORKFLOW_MAP.md', renderWorkflowMapMarkdown(model));
  write('CHANGE_PROTOCOL.md', renderChangeProtocolMarkdown(model));
  write('RISK_AREAS.md', renderRiskAreasMarkdown(model));
  write('CONTRADICTIONS.md', renderContradictionReportMarkdown(model.contradictions));
  write('OPEN_QUESTIONS.md', renderOpenQuestionsMarkdown(model));
  write('GENERATED_VS_HANDWRITTEN.md', renderGeneratedCodeReportMarkdown(model.generatedVsHandwritten));
  write('STABILITY.md', renderStabilityMapMarkdown(model.stableExperimentalDeprecated));
  write('TASK_CONTEXT_HINTS.md', renderTaskContextHintsMarkdown(model));
  write('REPOSITORY_KNOWLEDGE_MODEL.md', renderRepositoryKnowledgeModelMarkdown(model));

  // 3) Draft TS files.
  write('generated/knowledge.draft.ts', renderKnowledgeDraft(model));
  write('generated/rules.draft.ts', renderRulesDraft(model));
  write('generated/paths.draft.ts', renderPathsDraft(model));
  write('generated/boundaries.draft.ts', renderBoundariesDraft(model));
  write('generated/constructs.draft.ts', renderConstructsDraft(model));
  write('generated/policies.draft.ts', renderPoliciesDraft(model));
  write('generated/playbooks.draft.ts', renderPlaybooksDraft(model));
  write('generated/templates.draft.ts', renderTemplatesDraft(model));
  write('generated/pipelines.draft.ts', renderPipelinesDraft(model));
  write('generated/presets.draft.ts', renderPresetsDraft(model));

  return { outDir, files };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function renderRepoOverviewMarkdown(model: IRepositoryKnowledgeModel): string {
  const o = model.repositoryOverview;
  const lines: string[] = [];
  lines.push(`# Repository overview — ${o.projectName}`);
  lines.push('');
  if (o.description) lines.push(`> ${o.description}`);
  lines.push('');
  lines.push(`- Package manager: **${o.packageManager}**`);
  lines.push(`- TypeScript: **${o.detectedLanguages.includes('typescript') ? 'yes' : 'no'}**`);
  lines.push(`- Frameworks: ${o.frameworks.join(', ') || '_(none detected)_'}`);
  lines.push(`- Languages: ${o.detectedLanguages.join(', ') || '_(unknown)_'}`);
  lines.push(`- Monorepo: ${o.monorepo ? 'yes' : 'no'}`);
  lines.push(`- Top-level dirs: ${o.topLevelDirs.map((d) => '`' + d + '`').join(', ')}`);
  lines.push(`- Scripts: ${o.knownScripts.map((s) => '`' + s + '`').join(', ') || '_(none)_'}`);
  lines.push(`- SharkCraft folder present: **${o.hasSharkcraftFolder ? 'yes' : 'no'}**`);
  return lines.join('\n');
}

function renderArchitectureMarkdown(model: IRepositoryKnowledgeModel): string {
  const a = model.architectureModel;
  const lines: string[] = ['# Architecture model', ''];
  if (a.layers.length === 0) {
    lines.push('_No layers detected._');
  } else {
    lines.push('## Layers / areas');
    lines.push('');
    lines.push('| Id | Files | Paths |');
    lines.push('|---|---|---|');
    for (const l of a.layers) {
      lines.push(`| \`${l.id}\` | ${l.fileCount} | ${l.paths.map((p) => '`' + p + '`').join(', ')} |`);
    }
  }
  if (a.publicApis.length > 0) {
    lines.push('');
    lines.push('## Public APIs');
    lines.push('');
    for (const p of a.publicApis) lines.push(`- \`${p}\``);
  }
  if (a.notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    for (const n of a.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

function renderBusinessLogicMarkdown(model: IRepositoryKnowledgeModel): string {
  const b = model.businessLogicModel;
  const lines: string[] = ['# Business logic model', ''];
  lines.push('## Entities');
  lines.push('');
  if (b.entities.length === 0) lines.push('_None detected — entities are usually surfaced via constructs._');
  else {
    for (const e of b.entities) {
      lines.push(`### ${e.title}`);
      lines.push('');
      lines.push(e.summary);
      lines.push('');
      lines.push(`Paths: ${e.paths.map((p) => '`' + p + '`').join(', ') || '_(unknown)_'}`);
      lines.push('');
    }
  }
  lines.push('## Workflows');
  lines.push('');
  if (b.workflows.length === 0) lines.push('_None detected._');
  else {
    for (const w of b.workflows) {
      lines.push(`### ${w.title}`);
      lines.push('');
      lines.push(w.summary);
      lines.push('');
    }
  }
  if (b.invariants.length > 0) {
    lines.push('## Invariants');
    lines.push('');
    for (const inv of b.invariants) lines.push(`- ${inv}`);
  }
  return lines.join('\n');
}

function renderRulesMarkdown(model: IRepositoryKnowledgeModel): string {
  const r = model.rulesAndConventions;
  const lines: string[] = ['# Rules & conventions', ''];
  lines.push(`## Inferred rules (${r.rules.length})`);
  lines.push('');
  for (const rule of r.rules) {
    lines.push(`### ${rule.title} (\`${rule.id}\`)`);
    lines.push('');
    lines.push(`Priority: **${rule.priority}** · Source: ${rule.source}`);
    lines.push('');
    lines.push(rule.content);
    lines.push('');
    lines.push(`Reason: ${rule.reason}`);
    lines.push('');
  }
  lines.push(`## Path conventions (${r.paths.length})`);
  lines.push('');
  for (const p of r.paths) {
    lines.push(`- **${p.title}** (\`${p.id}\`) — ${p.content}`);
  }
  lines.push('');
  lines.push(`## Verification commands (${r.verificationCommands.length})`);
  lines.push('');
  for (const v of r.verificationCommands) {
    lines.push(`- \`${v.command}\` — ${v.label}${v.trusted ? '' : '  _(needs review)_'}`);
  }
  return lines.join('\n');
}

function renderBoundariesMarkdown(model: IRepositoryKnowledgeModel): string {
  const b = model.dependencyBoundaries;
  const lines: string[] = ['# Dependency boundaries', ''];
  if (b.rules.length === 0) lines.push('_No inferred boundaries — consider adding layer rules manually._');
  else {
    for (const rule of b.rules) {
      lines.push(`### ${rule.title} (\`${rule.id}\`)`);
      lines.push('');
      lines.push(`Severity: **${rule.severity}**`);
      lines.push('');
      lines.push(`From: ${rule.from.map((p) => '`' + p + '`').join(', ')}`);
      if (rule.forbiddenImports?.length) {
        lines.push(`Forbidden: ${rule.forbiddenImports.map((p) => '`' + p + '`').join(', ')}`);
      }
      if (rule.allowedImports?.length) {
        lines.push(`Allowed: ${rule.allowedImports.map((p) => '`' + p + '`').join(', ')}`);
      }
      lines.push('');
      lines.push(`Suggested fix: ${rule.suggestedFix}`);
      lines.push(`Reason: ${rule.reason}`);
      lines.push('');
    }
  }
  lines.push('## Import graph summary');
  lines.push('');
  lines.push(`- Files scanned: ${b.importGraphSummary.nodeCount}`);
  lines.push(`- Workspace packages: ${b.importGraphSummary.edgeCount}`);
  if (b.importGraphSummary.cycles.length > 0) {
    lines.push(`- Cycles: ${b.importGraphSummary.cycles.length}`);
    for (const c of b.importGraphSummary.cycles) lines.push(`  - ${c}`);
  }
  return lines.join('\n');
}

function renderDomainMapMarkdown(model: IRepositoryKnowledgeModel): string {
  const d = model.domainMap;
  const lines: string[] = ['# Domain map', ''];
  lines.push('## Areas');
  lines.push('');
  if (d.areas.length === 0) lines.push('_None._');
  else {
    lines.push('| Id | Kind | Files | Paths |');
    lines.push('|---|---|---|---|');
    for (const a of d.areas) {
      lines.push(`| \`${a.id}\` | ${a.kind} | ${a.fileCount} | ${a.paths.map((p) => '`' + p + '`').join(', ')} |`);
    }
  }
  lines.push('');
  lines.push('## Constructs');
  lines.push('');
  if (d.constructs.length === 0) lines.push('_None._');
  else {
    for (const c of d.constructs) {
      lines.push(`- **${c.title}** (\`${c.id}\`) — ${c.paths.length} path(s)`);
    }
  }
  return lines.join('\n');
}

function renderWorkflowMapMarkdown(model: IRepositoryKnowledgeModel): string {
  const lines: string[] = ['# Workflow map', ''];
  for (const w of model.workflowMap.workflows) {
    lines.push(`### ${w.title} (\`${w.id}\`)`);
    lines.push('');
    lines.push(`Source: ${w.source}`);
    lines.push('');
    for (const step of w.steps) lines.push(`- ${step}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderChangeProtocolMarkdown(model: IRepositoryKnowledgeModel): string {
  const lines: string[] = ['# Change protocol', ''];
  for (const c of model.changeProtocol.entries) {
    lines.push(`## ${c.title}`);
    lines.push('');
    for (const step of c.steps) lines.push(`- ${step}`);
    lines.push('');
    if (c.recommendedCommands.length) {
      lines.push('Commands:');
      lines.push('');
      for (const cmd of c.recommendedCommands) lines.push(`- \`${cmd}\``);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderRiskAreasMarkdown(model: IRepositoryKnowledgeModel): string {
  const lines: string[] = ['# Risk areas', ''];
  if (model.riskAreas.length === 0) lines.push('_No risk areas surfaced._');
  else {
    lines.push('| Path | Score | Reason | Recommendation |');
    lines.push('|---|---|---|---|');
    for (const r of model.riskAreas) {
      lines.push(`| \`${r.path}\` | ${r.score} | ${r.reason} | ${r.recommendation} |`);
    }
  }
  return lines.join('\n');
}

function renderOpenQuestionsMarkdown(model: IRepositoryKnowledgeModel): string {
  const lines: string[] = ['# Open questions', ''];
  if (model.openQuestions.length === 0) lines.push('_None._');
  else for (const q of model.openQuestions) lines.push(`- ${q}`);
  return lines.join('\n');
}

function renderTaskContextHintsMarkdown(model: IRepositoryKnowledgeModel): string {
  const lines: string[] = ['# Task context hints', ''];
  for (const h of model.taskContextHints) {
    lines.push(`- **${h.trigger}** — ${h.hint}${h.recommendedCommand ? `  _(\`${h.recommendedCommand}\`)_` : ''}`);
  }
  return lines.join('\n');
}

// ─── Draft TS emitters ─────────────────────────────────────────────────────

function header(comment: string): string {
  return `/**\n * ${comment}\n *\n * This is a DRAFT — review and copy entries into the canonical sharkcraft/*.ts file.\n * Generated by \`shrk ingest repository --write-drafts\`.\n */\n`;
}

function renderKnowledgeDraft(model: IRepositoryKnowledgeModel): string {
  const entries: string[] = [];
  for (const e of model.businessLogicModel.entities) {
    entries.push(`  {
    id: 'concept.${e.id}',
    title: ${JSON.stringify(e.title)},
    description: ${JSON.stringify(e.summary)},
    content: ${JSON.stringify(e.summary)},
    tags: ['domain', 'entity'],
  }`);
  }
  for (const w of model.businessLogicModel.workflows) {
    entries.push(`  {
    id: 'workflow.${w.id}',
    title: ${JSON.stringify(w.title)},
    description: ${JSON.stringify(w.summary)},
    content: ${JSON.stringify(w.summary)},
    tags: ['domain', 'workflow'],
  }`);
  }
  for (let i = 0; i < model.businessLogicModel.invariants.length; i += 1) {
    const inv = model.businessLogicModel.invariants[i] ?? '';
    entries.push(`  {
    id: 'invariant.${i}',
    title: 'Invariant ${i}',
    description: ${JSON.stringify(inv)},
    content: ${JSON.stringify(inv)},
    tags: ['invariant'],
  }`);
  }
  return `${header('Knowledge entries inferred from repository ingestion.')}
export const ingestedKnowledge = [
${entries.join(',\n')}
];

export default ingestedKnowledge;
`;
}

function renderRulesDraft(model: IRepositoryKnowledgeModel): string {
  const entries: string[] = [];
  for (const r of model.rulesAndConventions.rules) {
    entries.push(`  defineRule({
    id: ${JSON.stringify(r.id)},
    title: ${JSON.stringify(r.title)},
    priority: ${JSON.stringify(r.priority)},
    content: ${JSON.stringify(r.content)},
    reason: ${JSON.stringify(r.reason)},
  })`);
  }
  return `${header('Rules inferred from repository ingestion.')}
import { defineRule } from '@shrkcrft/rules';

export const ingestedRules = [
${entries.join(',\n')}
];

export default ingestedRules;
`;
}

function renderPathsDraft(model: IRepositoryKnowledgeModel): string {
  const entries = model.rulesAndConventions.paths.map((p) => `  definePath({
    id: ${JSON.stringify(p.id)},
    title: ${JSON.stringify(p.title)},
    content: ${JSON.stringify(p.content)},
    patterns: ${JSON.stringify(p.patterns)},
  })`);
  return `${header('Path conventions inferred from repository ingestion.')}
import { definePath } from '@shrkcrft/paths';

export const ingestedPaths = [
${entries.join(',\n')}
];

export default ingestedPaths;
`;
}

function renderBoundariesDraft(model: IRepositoryKnowledgeModel): string {
  const entries = model.dependencyBoundaries.rules.map((b) => `  defineBoundary({
    id: ${JSON.stringify(b.id)},
    title: ${JSON.stringify(b.title)},
    severity: ${JSON.stringify(b.severity)},
    from: ${JSON.stringify(b.from)},
    ${b.forbiddenImports ? `forbiddenImports: ${JSON.stringify(b.forbiddenImports)},` : ''}
    ${b.allowedImports ? `allowedImports: ${JSON.stringify(b.allowedImports)},` : ''}
    suggestedFix: ${JSON.stringify(b.suggestedFix)},
  })`);
  return `${header('Dependency-boundary rules inferred from repository ingestion.')}
import { defineBoundary } from '@shrkcrft/boundaries';

export const ingestedBoundaries = [
${entries.join(',\n')}
];

export default ingestedBoundaries;
`;
}

function renderConstructsDraft(model: IRepositoryKnowledgeModel): string {
  const entries = model.domainMap.constructs.map((c) => `  defineConstruct({
    id: ${JSON.stringify(c.id)},
    type: 'inferred',
    title: ${JSON.stringify(c.title)},
    files: ${JSON.stringify(c.paths)},
  })`);
  return `${header('Constructs inferred from repository ingestion.')}
import { defineConstruct } from '@shrkcrft/plugin-api';

export const ingestedConstructs = [
${entries.join(',\n')}
];

export default ingestedConstructs;
`;
}

function renderPoliciesDraft(model: IRepositoryKnowledgeModel): string {
  const entries: string[] = [];
  for (const p of model.generatedVsHandwritten.recommendedPolicyRules) {
    entries.push(`  {
    id: ${JSON.stringify(p.suggestedId)},
    title: ${JSON.stringify(p.title)},
    description: ${JSON.stringify(p.description)},
    patterns: ${JSON.stringify(p.patterns)},
  }`);
  }
  return `${header('Policy rules inferred from repository ingestion.')}
export const ingestedPolicies = [
${entries.join(',\n')}
];

export default ingestedPolicies;
`;
}

function renderPlaybooksDraft(model: IRepositoryKnowledgeModel): string {
  const entries = model.changeProtocol.entries.map((p) => `  {
    id: ${JSON.stringify(p.id)},
    title: ${JSON.stringify(p.title)},
    steps: ${JSON.stringify(p.steps)},
    commands: ${JSON.stringify(p.recommendedCommands)},
  }`);
  return `${header('Playbooks inferred from repository ingestion.')}
export const ingestedPlaybooks = [
${entries.join(',\n')}
];

export default ingestedPlaybooks;
`;
}

function renderTemplatesDraft(model: IRepositoryKnowledgeModel): string {
  const safe = model.inferredTemplates.filter((t) => t.confidence !== 'low');
  const entries = safe.map((t) => `  // ${t.id} — ${t.confidence} confidence: ${t.reason}\n  /* template body left as a draft — copy from sharkcraft/onboarding once reviewed */`);
  return `${header('Templates inferred from repository ingestion (high/medium confidence only).')}
// To keep the draft safe, the actual template bodies are not auto-emitted here.
// Run \`shrk infer templates --ast\` to produce runnable bodies, then copy
// reviewed entries into sharkcraft/templates.ts.

export const ingestedTemplates: unknown[] = [
${entries.join(',\n')}
];

export default ingestedTemplates;
`;
}

function renderPipelinesDraft(model: IRepositoryKnowledgeModel): string {
  const entries = model.inferredPipelines.map((p) => `  {
    id: ${JSON.stringify(p.id)},
    title: ${JSON.stringify(p.title)},
    description: ${JSON.stringify(p.description)},
    steps: ${JSON.stringify(p.steps)},
  }`);
  return `${header('Pipelines inferred from repository ingestion.')}
export const ingestedPipelines = [
${entries.join(',\n')}
];

export default ingestedPipelines;
`;
}

function renderPresetsDraft(model: IRepositoryKnowledgeModel): string {
  const ids = model.presets.map((r) => r.preset.id);
  return `${header('Local preset bundle inferred from repository ingestion.')}
export const ingestedPresetBundle = {
  id: 'local.bundle',
  title: 'Local preset bundle',
  description: 'Bundle of presets ranked for this repo by the ingestion pipeline.',
  members: ${JSON.stringify(ids)},
};

export default ingestedPresetBundle;
`;
}
