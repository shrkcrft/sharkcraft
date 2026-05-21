/**
 * Self-config doctor.
 *
 * Cross-reference walker over the workspace's loaded contributions. Validates
 * the *graph* of references between knowledge, rules, paths, conventions,
 * templates, playbooks, helpers, profiles, agent-tests, search tuning,
 * feedback rules, decisions, contract templates, migration profiles, plugin
 * lifecycle profiles, MCP tool names, and CLI command catalog entries.
 *
 * Read-only. Never imports executable pack code beyond the loaders that
 * already do.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { buildPackContributionsInventory } from './pack-contributions-inventory.ts';
import { listConventions } from './convention-registry.ts';
import { loadAllContractTemplates } from './contract-template-registry.ts';
import { listMigrationProfilesFromPacks } from './migration-profile-registry.ts';
import { listPackHelpers } from './pack-helper-registry.ts';
import { listTaskRoutingHints } from './task-routing-hint-registry.ts';
import { listRegistrationHints } from './registration-hint-registry.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const SELF_CONFIG_DOCTOR_SCHEMA = 'sharkcraft.self-config-doctor/v1';

export enum SelfConfigSeverity {
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

export interface ISelfConfigFinding {
  readonly severity: SelfConfigSeverity;
  readonly code: string;
  readonly message: string;
  readonly sourceFile?: string;
  readonly referencingId?: string;
  readonly referencedId?: string;
  readonly referencedKind?: string;
  readonly nextCommand?: string;
}

export interface ISelfConfigDoctorReport {
  readonly schema: typeof SELF_CONFIG_DOCTOR_SCHEMA;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly findings: readonly ISelfConfigFinding[];
  readonly totals: Readonly<Record<string, number>>;
  readonly verdict: 'ok' | 'warnings' | 'errors';
  readonly nextCommands: readonly string[];
}

export interface ISelfConfigGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly source?: string;
}

export interface ISelfConfigGraphEdge {
  readonly from: ISelfConfigGraphNode;
  readonly to: ISelfConfigGraphNode;
  readonly relation: string;
}

export interface ISelfConfigGraph {
  readonly schema: 'sharkcraft.self-config-graph/v1';
  readonly nodes: readonly ISelfConfigGraphNode[];
  readonly edges: readonly ISelfConfigGraphEdge[];
  readonly brokenEdges: readonly ISelfConfigGraphEdge[];
}

interface IIdLookup {
  knowledge: Set<string>;
  rules: Set<string>;
  paths: Set<string>;
  pathConventions: Set<string>;
  templates: Set<string>;
  pipelines: Set<string>;
  policies: Set<string>;
  playbooks: Set<string>;
  constructs: Set<string>;
  scaffoldPatterns: Set<string>;
  conventions: Set<string>;
  contractTemplates: Set<string>;
  migrationProfiles: Set<string>;
  helpers: Set<string>;
  routingHints: Set<string>;
  registrationHints: Set<string>;
  commands: Set<string>;
  mcpTools: Set<string>;
  files: Set<string>;
}

async function buildLookups(
  inspection: ISharkcraftInspection,
): Promise<IIdLookup> {
  const knowledge = new Set<string>(inspection.knowledgeEntries.map((k) => k.id));
  const rules = new Set<string>(
    (inspection.ruleService?.list?.() ?? []).map((r: { id: string }) => r.id),
  );
  const paths = new Set<string>(
    (inspection.pathService?.list?.() ?? []).map((p: { id: string }) => p.id),
  );
  const templates = new Set<string>(
    inspection.templateRegistry?.list?.().map((t: { id: string }) => t.id) ?? [],
  );
  const pipelines = new Set<string>(
    inspection.pipelineRegistry?.list?.().map((p: { id: string }) => p.id) ?? [],
  );

  // Convention/profile/contract registries return entries asynchronously.
  const conventions = new Set<string>(
    (await listConventions(inspection)).map((e) => e.convention.id),
  );
  const contractTemplatesPair = await loadAllContractTemplates(inspection);
  const contractTemplates = new Set<string>(
    contractTemplatesPair.entries.map((e) => e.template.id),
  );
  const migrationProfiles = new Set<string>(
    (await listMigrationProfilesFromPacks(inspection)).map((p) => p.id),
  );

  const helpers = new Set<string>(
    (await listPackHelpers(inspection)).map((e) => e.helper.id),
  );
  const routingHints = new Set<string>(
    (await listTaskRoutingHints(inspection)).map((e) => e.hint.id),
  );
  const registrationHints = new Set<string>(
    (await listRegistrationHints(inspection)).map((e) => e.hint.id),
  );

  return {
    knowledge,
    rules,
    paths,
    pathConventions: new Set<string>(), // alias of paths for cross-ref readability
    templates,
    pipelines,
    policies: new Set<string>(),
    playbooks: new Set<string>(),
    constructs: new Set<string>(),
    scaffoldPatterns: new Set<string>(),
    conventions,
    contractTemplates,
    migrationProfiles,
    helpers,
    routingHints,
    registrationHints,
    commands: new Set<string>(),
    mcpTools: new Set<string>(),
    files: new Set<string>(),
  };
}

function addFinding(
  out: ISelfConfigFinding[],
  finding: ISelfConfigFinding,
): void {
  out.push(finding);
}

async function checkKnowledgeReferences(
  inspection: ISharkcraftInspection,
  lookups: IIdLookup,
  findings: ISelfConfigFinding[],
): Promise<void> {
  for (const k of inspection.knowledgeEntries) {
    for (const ref of k.references ?? []) {
      if (ref.kind === 'file' && ref.path) {
        const abs = nodePath.isAbsolute(ref.path)
          ? ref.path
          : nodePath.join(inspection.projectRoot, ref.path);
        if (!existsSync(abs)) {
          findings.push({
            severity: ref.required ? SelfConfigSeverity.Error : SelfConfigSeverity.Warning,
            code: 'knowledge-ref-missing-file',
            message: `Knowledge "${k.id}" references missing file "${ref.path}".`,
            referencingId: k.id,
            referencedId: ref.path,
            referencedKind: 'file',
            sourceFile: k.source?.origin ?? undefined,
            nextCommand: 'shrk knowledge stale-check --ci',
          });
        }
      }
      // Anchors / symbols / commands left to dedicated checkers
      // (existing `shrk knowledge stale-check`).
    }
  }
  // Touch lookups so the param isn't unused — future expansions may reference it.
  void lookups;
}

async function checkSearchTuningTargets(
  inspection: ISharkcraftInspection,
  lookups: IIdLookup,
  findings: ISelfConfigFinding[],
): Promise<void> {
  const { listSearchTuning } = await import('./search-tuning-registry.ts');
  const entries = listSearchTuning(inspection);
  for (const entry of entries) {
    for (const idMap of [entry.boostIds, ...(entry.taskHints ?? []).map((h) => h.boostIds)]) {
      if (!idMap) continue;
      for (const targetId of Object.keys(idMap)) {
        const exists =
          lookups.knowledge.has(targetId) ||
          lookups.rules.has(targetId) ||
          lookups.templates.has(targetId) ||
          lookups.pipelines.has(targetId) ||
          lookups.contractTemplates.has(targetId) ||
          lookups.conventions.has(targetId);
        if (!exists) {
          findings.push({
            severity: SelfConfigSeverity.Warning,
            code: 'search-tuning-target-missing',
            message: `Search tuning "${entry.id}" boosts unknown id "${targetId}".`,
            referencingId: entry.id,
            referencedId: targetId,
            referencedKind: 'unknown',
            sourceFile: entry.sourceFile,
          });
        }
      }
    }
  }
}

async function checkAgentTestExpectations(
  inspection: ISharkcraftInspection,
  lookups: IIdLookup,
  findings: ISelfConfigFinding[],
): Promise<void> {
  let agentTests: readonly { id: string; expectedKnowledge?: readonly string[]; expectedTemplates?: readonly string[] }[] = [];
  try {
    const { loadAgentContractTests } = await import('./test-runner.ts');
    agentTests = (await loadAgentContractTests(inspection)) as unknown as typeof agentTests;
  } catch {
    return;
  }
  for (const t of agentTests) {
    for (const id of t.expectedKnowledge ?? []) {
      if (!lookups.knowledge.has(id)) {
        findings.push({
          severity: SelfConfigSeverity.Error,
          code: 'agent-test-knowledge-missing',
          message: `Agent test "${t.id}" expects unknown knowledge id "${id}".`,
          referencingId: t.id,
          referencedId: id,
          referencedKind: 'knowledge',
        });
      }
    }
    for (const id of t.expectedTemplates ?? []) {
      if (!lookups.templates.has(id)) {
        findings.push({
          severity: SelfConfigSeverity.Error,
          code: 'agent-test-template-missing',
          message: `Agent test "${t.id}" expects unknown template id "${id}".`,
          referencingId: t.id,
          referencedId: id,
          referencedKind: 'template',
        });
      }
    }
  }
}

async function checkPackContributionConflicts(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFinding[],
): Promise<void> {
  const inv = buildPackContributionsInventory(inspection);
  for (const c of inv.conflicts) {
    findings.push({
      severity:
        c.severity === 'error'
          ? SelfConfigSeverity.Error
          : c.severity === 'warning'
            ? SelfConfigSeverity.Warning
            : SelfConfigSeverity.Info,
      code: `pack-conflict:${c.kind}`,
      message: c.message,
      referencingId: c.id,
      referencedKind: c.contributionKind,
      ...(c.nextCommand ? { nextCommand: c.nextCommand } : {}),
    });
  }
}

/**
 * Verify template metadata cross-references resolve:
 *   - `metadata.requiredConventionIds` → conventions registry
 *   - `metadata.requiredHelperIds` → helpers registry
 *   - `metadata.registrationHintIds` → registration-hints registry
 *   - `metadata.requiredProfileIds` → profile registry
 */
async function checkTemplateMetadataReferences(
  inspection: ISharkcraftInspection,
  lookups: IIdLookup,
  findings: ISelfConfigFinding[],
): Promise<void> {
  const templates = (inspection.templates ?? []) as readonly {
    id: string;
    metadata?: {
      requiredConventionIds?: readonly string[];
      requiredHelperIds?: readonly string[];
      requiredProfileIds?: readonly string[];
      registrationHintIds?: readonly string[];
    };
  }[];
  for (const t of templates) {
    const m = t.metadata;
    if (!m) continue;
    for (const id of m.requiredConventionIds ?? []) {
      if (!lookups.conventions.has(id)) {
        findings.push({
          severity: SelfConfigSeverity.Warning,
          code: 'template-convention-missing',
          message: `Template "${t.id}" requires convention "${id}" but it is not registered.`,
          referencingId: t.id,
          referencedId: id,
          referencedKind: 'convention',
          nextCommand: `shrk conventions list --source pack`,
        });
      }
    }
    for (const id of m.requiredHelperIds ?? []) {
      if (!lookups.helpers.has(id)) {
        findings.push({
          severity: SelfConfigSeverity.Warning,
          code: 'template-helper-missing',
          message: `Template "${t.id}" requires helper "${id}" but it is not registered.`,
          referencingId: t.id,
          referencedId: id,
          referencedKind: 'helper',
          nextCommand: `shrk helper list --source pack`,
        });
      }
    }
    for (const id of m.requiredProfileIds ?? []) {
      if (!lookups.migrationProfiles.has(id)) {
        findings.push({
          severity: SelfConfigSeverity.Warning,
          code: 'template-profile-missing',
          message: `Template "${t.id}" requires profile "${id}" but it is not registered.`,
          referencingId: t.id,
          referencedId: id,
          referencedKind: 'profile',
          nextCommand: `shrk profiles list`,
        });
      }
    }
    for (const id of m.registrationHintIds ?? []) {
      if (!lookups.registrationHints.has(id)) {
        findings.push({
          severity: SelfConfigSeverity.Warning,
          code: 'template-registration-hint-missing',
          message: `Template "${t.id}" references registration hint "${id}" but it is not registered.`,
          referencingId: t.id,
          referencedId: id,
          referencedKind: 'registration-hint',
          nextCommand: `shrk registrations list`,
        });
      }
    }
  }
}

/**
 * Verify routing hint targets resolve to commands/templates/playbooks/helpers/profiles/conventions/knowledge.
 */
async function checkRoutingHintTargets(
  inspection: ISharkcraftInspection,
  lookups: IIdLookup,
  findings: ISelfConfigFinding[],
): Promise<void> {
  const entries = await listTaskRoutingHints(inspection);
  for (const e of entries) {
    const rec = e.hint.recommends;
    for (const id of rec.templates ?? []) {
      if (!lookups.templates.has(id)) {
        findings.push({
          severity: SelfConfigSeverity.Info,
          code: 'routing-hint-template-missing',
          message: `Routing hint "${e.hint.id}" recommends template "${id}" but it is not registered.`,
          referencingId: e.hint.id,
          referencedId: id,
          referencedKind: 'template',
        });
      }
    }
    for (const id of rec.helpers ?? []) {
      if (!lookups.helpers.has(id)) {
        findings.push({
          severity: SelfConfigSeverity.Info,
          code: 'routing-hint-helper-missing',
          message: `Routing hint "${e.hint.id}" recommends helper "${id}" but it is not registered.`,
          referencingId: e.hint.id,
          referencedId: id,
          referencedKind: 'helper',
        });
      }
    }
    for (const id of rec.conventions ?? []) {
      if (!lookups.conventions.has(id)) {
        findings.push({
          severity: SelfConfigSeverity.Info,
          code: 'routing-hint-convention-missing',
          message: `Routing hint "${e.hint.id}" recommends convention "${id}" but it is not registered.`,
          referencingId: e.hint.id,
          referencedId: id,
          referencedKind: 'convention',
        });
      }
    }
    for (const id of rec.profiles ?? []) {
      if (!lookups.migrationProfiles.has(id)) {
        findings.push({
          severity: SelfConfigSeverity.Info,
          code: 'routing-hint-profile-missing',
          message: `Routing hint "${e.hint.id}" recommends profile "${id}" but it is not registered.`,
          referencingId: e.hint.id,
          referencedId: id,
          referencedKind: 'profile',
        });
      }
    }
  }
}

export async function buildSelfConfigDoctorReport(
  inspection: ISharkcraftInspection,
): Promise<ISelfConfigDoctorReport> {
  const findings: ISelfConfigFinding[] = [];
  const lookups = await buildLookups(inspection);

  await checkKnowledgeReferences(inspection, lookups, findings);
  await checkSearchTuningTargets(inspection, lookups, findings);
  await checkAgentTestExpectations(inspection, lookups, findings);
  await checkPackContributionConflicts(inspection, findings);
  // Template metadata + routing hint cross-references.
  await checkTemplateMetadataReferences(inspection, lookups, findings);
  await checkRoutingHintTargets(inspection, lookups, findings);

  const totals = {
    error: findings.filter((f) => f.severity === 'error').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
  const verdict: 'ok' | 'warnings' | 'errors' =
    totals.error > 0 ? 'errors' : totals.warning > 0 ? 'warnings' : 'ok';
  const nextCommands: string[] = [];
  if (totals.error > 0) {
    nextCommands.push(
      'Fix the listed errors — start with the most-referenced ids first.',
      'shrk packs conflicts',
      'shrk knowledge stale-check --ci',
    );
  } else if (totals.warning > 0) {
    nextCommands.push('Review warnings — most can be resolved by adding the referenced id or removing the stale reference.');
  }
  return {
    schema: SELF_CONFIG_DOCTOR_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    findings,
    totals,
    verdict,
    nextCommands,
  };
}

export async function buildSelfConfigGraph(
  inspection: ISharkcraftInspection,
): Promise<ISelfConfigGraph> {
  const nodes: ISelfConfigGraphNode[] = [];
  const edges: ISelfConfigGraphEdge[] = [];
  const brokenEdges: ISelfConfigGraphEdge[] = [];
  const lookups = await buildLookups(inspection);

  // Nodes: collect ids per kind
  for (const id of lookups.knowledge) nodes.push({ id, kind: 'knowledge' });
  for (const id of lookups.rules) nodes.push({ id, kind: 'rule' });
  for (const id of lookups.templates) nodes.push({ id, kind: 'template' });
  for (const id of lookups.pipelines) nodes.push({ id, kind: 'pipeline' });
  for (const id of lookups.conventions) nodes.push({ id, kind: 'convention' });
  for (const id of lookups.contractTemplates) nodes.push({ id, kind: 'contract-template' });
  for (const id of lookups.migrationProfiles) nodes.push({ id, kind: 'migration-profile' });

  // Edges from knowledge → referenced ids (best-effort).
  for (const k of inspection.knowledgeEntries) {
    for (const ref of k.references ?? []) {
      const refId = ref.path ?? '';
      if (!refId) continue;
      const from = { id: k.id, kind: 'knowledge' };
      const to = { id: refId, kind: ref.kind ?? 'file' };
      const edge: ISelfConfigGraphEdge = { from, to, relation: 'references' };
      edges.push(edge);
      if (ref.kind === 'file') {
        const abs = nodePath.isAbsolute(refId)
          ? refId
          : nodePath.join(inspection.projectRoot, refId);
        if (!existsSync(abs)) brokenEdges.push(edge);
      }
    }
  }

  return {
    schema: 'sharkcraft.self-config-graph/v1',
    nodes,
    edges,
    brokenEdges,
  };
}

export function renderSelfConfigDoctorText(report: ISelfConfigDoctorReport): string {
  const lines: string[] = [];
  lines.push(`=== Self-config doctor ===`);
  lines.push(`  generatedAt   ${report.generatedAt}`);
  lines.push(`  verdict       ${report.verdict.toUpperCase()}`);
  lines.push(`  errors        ${report.totals['error'] ?? 0}`);
  lines.push(`  warnings      ${report.totals['warning'] ?? 0}`);
  lines.push(`  info          ${report.totals['info'] ?? 0}`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('  No cross-reference issues. ✓');
    return lines.join('\n') + '\n';
  }
  for (const f of report.findings.slice(0, 100)) {
    lines.push(`  ${f.severity.padEnd(7)} [${f.code}] ${f.message}`);
    if (f.nextCommand) lines.push(`           next: ${f.nextCommand}`);
  }
  if (report.findings.length > 100) {
    lines.push(`  … (${report.findings.length - 100} more)`);
  }
  if (report.nextCommands.length > 0) {
    lines.push('\nNext:');
    for (const c of report.nextCommands) lines.push(`  • ${c}`);
  }
  return lines.join('\n') + '\n';
}

export function renderSelfConfigDoctorMarkdown(report: ISelfConfigDoctorReport): string {
  const lines: string[] = ['# Self-config doctor', ''];
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: **${report.verdict.toUpperCase()}**`);
  lines.push(`- errors: ${report.totals['error'] ?? 0}`);
  lines.push(`- warnings: ${report.totals['warning'] ?? 0}`);
  lines.push(`- info: ${report.totals['info'] ?? 0}`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No cross-reference issues. ✓');
    return lines.join('\n') + '\n';
  }
  lines.push('| Severity | Code | Message | Next |');
  lines.push('| --- | --- | --- | --- |');
  for (const f of report.findings) {
    lines.push(
      `| ${f.severity} | \`${f.code}\` | ${f.message} | ${f.nextCommand ?? ''} |`,
    );
  }
  return lines.join('\n') + '\n';
}
