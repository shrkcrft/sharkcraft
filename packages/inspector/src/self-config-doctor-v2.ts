/**
 * Self-config doctor v2.
 *
 * True cross-reference graph validation. Same read-only contract as v1, but
 * with a richer finding schema and additional checks the v1 walker did not
 * perform:
 *
 *   - agent-tests   → helpers / commands / playbooks / policies
 *   - policies      → rules / commands / paths
 *   - pipelines     → templates / commands (via step.cliCommands)
 *   - playbooks     → templates / helpers / commands / profiles
 *   - registration-hints → templates / conventions / profiles
 *   - decisions     → related rules / commands / files / knowledge / templates / playbooks / policies / constructs
 *
 * The v1 schema (sharkcraft.self-config-doctor/v1) is kept; v2 is opt-in by
 * default from the CLI but can be requested explicitly via `--schema v2`.
 */
import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { listTaskRoutingHints } from './task-routing-hint-registry.ts';
import { listRegistrationHints } from './registration-hint-registry.ts';
import { listDecisions } from './decision-records.ts';
import {
  referenceIdExistsInAnyKind,
  referenceIdsFor,
  warmReferenceRegistries,
  type ReferenceKind,
} from './reference-registry.ts';
import { listPlaybooks } from './playbook-registry.ts';
import { buildPackContributionsInventory } from './pack-contributions-inventory.ts';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';

export const SELF_CONFIG_DOCTOR_V2_SCHEMA = 'sharkcraft.self-config-doctor/v2';

export enum SelfConfigSeverityV2 {
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

/**
 * Source / target kind taxonomy. Open string for forward-compat with
 * pack-contributed kinds, but the engine emits one of these values.
 */
export type SelfConfigKind =
  | 'knowledge'
  | 'command'
  | 'helper'
  | 'template'
  | 'playbook'
  | 'pipeline'
  | 'policy'
  | 'rule'
  | 'path'
  | 'convention'
  | 'registration-hint'
  | 'routing-hint'
  | 'agent-test'
  | 'decision'
  | 'profile'
  | 'migration-profile'
  | 'contract-template'
  | 'pack'
  | 'schema'
  | 'file'
  | 'unknown';

/**
 * Edge relation taxonomy. Open string to allow future relations.
 */
export type SelfConfigRelation =
  | 'references'
  | 'expects'
  | 'validates'
  | 'requires'
  | 'produces'
  | 'routes-to'
  | 'tunes'
  | 'documents'
  | 'supersedes'
  | 'related';

export interface ISelfConfigFindingV2 {
  readonly id: string;
  readonly severity: SelfConfigSeverityV2;
  readonly code: string;
  readonly sourceKind: SelfConfigKind;
  readonly sourceId: string;
  readonly targetKind: SelfConfigKind;
  readonly targetId: string;
  readonly relation: SelfConfigRelation;
  readonly file?: string;
  readonly message: string;
  readonly suggestedFix?: string;
  readonly nextCommand?: string;
  /**
   * Reporter confidence in this finding.
   *   - high   — extracted from authoritative loader output
   *   - medium — extracted from authoritative loader but relation is weak
   *   - low    — derived from regex / fallback parsing
   */
  readonly confidence: 'high' | 'medium' | 'low';
}

export interface ISelfConfigDoctorReportV2 {
  readonly schema: typeof SELF_CONFIG_DOCTOR_V2_SCHEMA;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly findings: readonly ISelfConfigFindingV2[];
  readonly totals: Readonly<{
    error: number;
    warning: number;
    info: number;
    byRelation: Readonly<Record<string, number>>;
    bySourceKind: Readonly<Record<string, number>>;
    byTargetKind: Readonly<Record<string, number>>;
  }>;
  readonly verdict: 'ok' | 'warnings' | 'errors';
  readonly nextCommands: readonly string[];
}

interface IIdLookupsV2 {
  knowledge: Set<string>;
  rules: Set<string>;
  paths: Set<string>;
  templates: Set<string>;
  pipelines: Set<string>;
  policies: Set<string>;
  playbooks: Set<string>;
  conventions: Set<string>;
  contractTemplates: Set<string>;
  migrationProfiles: Set<string>;
  helpers: Set<string>;
  routingHints: Set<string>;
  registrationHints: Set<string>;
  decisions: Set<string>;
  scaffoldPatterns: Set<string>;
  commands: Set<string>;
}

async function buildLookupsV2(
  inspection: ISharkcraftInspection,
): Promise<IIdLookupsV2> {
  // Every set is a projection of the SHARED reference registry — the same
  // module the prose linter and the structured-`references[]` validator use.
  //
  // These sets used to be built here from their own sources, and the doc claim
  // "there is one definition of does-this-id-exist, not two" was true only by
  // coincidence. It was not always true: `policies` came from the pack
  // contributions inventory alone, so every LOCALLY declared policy read as
  // unknown; `scaffoldPatterns` had no set at all; `commands` read a
  // `repositoryCommands` property nothing assigns. Seven of shrk's own
  // correctly-registered ids were reported missing.
  await warmReferenceRegistries(inspection);
  const ids = (kind: ReferenceKind): Set<string> =>
    new Set<string>(referenceIdsFor(inspection, kind));

  return {
    knowledge: ids('knowledge'),
    rules: ids('rule'),
    paths: ids('path-convention'),
    templates: ids('template'),
    pipelines: ids('pipeline'),
    policies: ids('policy'),
    playbooks: ids('playbook'),
    conventions: ids('convention'),
    contractTemplates: ids('contract-template'),
    migrationProfiles: ids('migration-profile'),
    helpers: ids('helper'),
    routingHints: ids('routing-hint'),
    registrationHints: ids('registration-hint'),
    decisions: ids('decision'),
    scaffoldPatterns: ids('scaffold-pattern'),
    // The catalog lives in the CLI package, above this layer. `command`
    // resolves by SHAPE in the shared registry rather than by a list this
    // layer cannot see.
    commands: new Set<string>(),
  };
}

function findingId(parts: {
  sourceKind: SelfConfigKind;
  sourceId: string;
  targetKind: SelfConfigKind;
  targetId: string;
  relation: SelfConfigRelation;
}): string {
  return `${parts.sourceKind}:${parts.sourceId}|${parts.relation}|${parts.targetKind}:${parts.targetId}`;
}

interface IFindingInput {
  severity: SelfConfigSeverityV2;
  code: string;
  sourceKind: SelfConfigKind;
  sourceId: string;
  targetKind: SelfConfigKind;
  targetId: string;
  relation: SelfConfigRelation;
  file?: string | undefined;
  message: string;
  suggestedFix?: string | undefined;
  nextCommand?: string | undefined;
  confidence?: 'high' | 'medium' | 'low';
}

function pushFinding(out: ISelfConfigFindingV2[], input: IFindingInput): void {
  const entry: ISelfConfigFindingV2 = {
    id: findingId(input),
    severity: input.severity,
    code: input.code,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    relation: input.relation,
    message: input.message,
    confidence: input.confidence ?? 'high',
    ...(input.file !== undefined ? { file: input.file } : {}),
    ...(input.suggestedFix !== undefined ? { suggestedFix: input.suggestedFix } : {}),
    ...(input.nextCommand !== undefined ? { nextCommand: input.nextCommand } : {}),
  };
  out.push(entry);
}

// ─── 1. Knowledge → file references ───────────────────────────────────────

function checkKnowledgeFileRefs(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): void {
  for (const k of inspection.knowledgeEntries) {
    for (const ref of k.references ?? []) {
      if (ref.kind !== 'file' || !ref.path) continue;
      const abs = nodePath.isAbsolute(ref.path)
        ? ref.path
        : nodePath.join(inspection.projectRoot, ref.path);
      if (existsSync(abs)) continue;
      pushFinding(findings, {
        severity: ref.required
          ? SelfConfigSeverityV2.Error
          : SelfConfigSeverityV2.Warning,
        code: 'knowledge-ref-missing-file',
        sourceKind: 'knowledge',
        sourceId: k.id,
        targetKind: 'file',
        targetId: ref.path,
        relation: 'references',
        file: k.source?.origin ?? undefined,
        message: `Knowledge "${k.id}" references missing file "${ref.path}".`,
        suggestedFix: `Create the file or update the knowledge reference.`,
        nextCommand: 'shrk knowledge stale-check --ci',
      });
    }
  }
}

// ─── 2. Search-tuning targets ─────────────────────────────────────────────

async function checkSearchTuning(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): Promise<void> {
  const { listSearchTuning } = await import('./search-tuning-registry.ts');
  const entries = listSearchTuning(inspection);
  for (const entry of entries) {
    const boostMaps = [entry.boostIds, ...(entry.taskHints ?? []).map((h) => h.boostIds)];
    for (const idMap of boostMaps) {
      if (!idMap) continue;
      for (const targetId of Object.keys(idMap)) {
        // Not a hand-maintained chain of `lookups.x.has(...)`: that list
        // silently omitted policies, decisions and scaffold patterns, so ids
        // that WERE registered got reported as unknown. Adding a kind to the
        // registry now widens this automatically.
        if (referenceIdExistsInAnyKind(inspection, targetId)) continue;
        pushFinding(findings, {
          severity: SelfConfigSeverityV2.Warning,
          code: 'search-tuning-target-missing',
          sourceKind: 'unknown',
          sourceId: entry.id,
          targetKind: 'unknown',
          targetId,
          relation: 'tunes',
          file: entry.sourceFile,
          message: `Search tuning "${entry.id}" boosts unknown id "${targetId}".`,
          suggestedFix: 'Register the target id or remove the boost entry.',
        });
      }
    }
  }
}

// ─── 3. Agent-tests → helpers / commands / playbooks / policies ───────────

async function checkAgentTests(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): Promise<void> {
  type IAgentTestLite = {
    id: string;
    expectedKnowledge?: readonly string[];
    expectedTemplates?: readonly string[];
    expectedHelpers?: readonly string[];
    expectedPlaybooks?: readonly string[];
    expectedPolicies?: readonly string[];
    expectedCommands?: readonly string[];
  };
  let agentTests: readonly IAgentTestLite[] = [];
  try {
    const { loadAgentContractTests } = await import('./test-runner.ts');
    agentTests = (await loadAgentContractTests(inspection)) as unknown as readonly IAgentTestLite[];
  } catch {
    return;
  }

  const probe = (
    t: IAgentTestLite,
    ids: readonly string[] | undefined,
    targetKind: SelfConfigKind,
    lookup: Set<string>,
    relation: SelfConfigRelation,
  ): void => {
    if (!ids) return;
    for (const id of ids) {
      if (lookup.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Error,
        code: `agent-test-${targetKind}-missing`,
        sourceKind: 'agent-test',
        sourceId: t.id,
        targetKind,
        targetId: id,
        relation,
        message: `Agent test "${t.id}" expects unknown ${targetKind} id "${id}".`,
        suggestedFix: `Register the ${targetKind} or drop the expectation.`,
      });
    }
  };

  for (const t of agentTests) {
    probe(t, t.expectedKnowledge, 'knowledge', lookups.knowledge, 'expects');
    probe(t, t.expectedTemplates, 'template', lookups.templates, 'expects');
    probe(t, t.expectedHelpers, 'helper', lookups.helpers, 'expects');
    probe(t, t.expectedPlaybooks, 'playbook', lookups.playbooks, 'expects');
    probe(t, t.expectedPolicies, 'policy', lookups.policies, 'expects');
    probe(t, t.expectedCommands, 'command', lookups.commands, 'expects');
  }
}

// ─── 4. Templates → conventions / helpers / profiles / registration hints ─

function checkTemplateMetadata(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): void {
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
      if (lookups.conventions.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Warning,
        code: 'template-convention-missing',
        sourceKind: 'template',
        sourceId: t.id,
        targetKind: 'convention',
        targetId: id,
        relation: 'requires',
        message: `Template "${t.id}" requires convention "${id}" but it is not registered.`,
        nextCommand: 'shrk conventions list --source pack',
      });
    }
    for (const id of m.requiredHelperIds ?? []) {
      if (lookups.helpers.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Warning,
        code: 'template-helper-missing',
        sourceKind: 'template',
        sourceId: t.id,
        targetKind: 'helper',
        targetId: id,
        relation: 'requires',
        message: `Template "${t.id}" requires helper "${id}" but it is not registered.`,
        nextCommand: 'shrk helper list --source pack',
      });
    }
    for (const id of m.requiredProfileIds ?? []) {
      if (lookups.migrationProfiles.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Warning,
        code: 'template-profile-missing',
        sourceKind: 'template',
        sourceId: t.id,
        targetKind: 'profile',
        targetId: id,
        relation: 'requires',
        message: `Template "${t.id}" requires profile "${id}" but it is not registered.`,
        nextCommand: 'shrk profiles list',
      });
    }
    for (const id of m.registrationHintIds ?? []) {
      if (lookups.registrationHints.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Warning,
        code: 'template-registration-hint-missing',
        sourceKind: 'template',
        sourceId: t.id,
        targetKind: 'registration-hint',
        targetId: id,
        relation: 'requires',
        message: `Template "${t.id}" references registration hint "${id}" but it is not registered.`,
        nextCommand: 'shrk registrations list',
      });
    }
  }
}

// ─── 5. Routing hints → commands / templates / helpers / playbooks / profiles ───

async function checkRoutingHints(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): Promise<void> {
  const entries = await listTaskRoutingHints(inspection);
  for (const e of entries) {
    const rec = e.hint.recommends as {
      templates?: readonly string[];
      helpers?: readonly string[];
      conventions?: readonly string[];
      profiles?: readonly string[];
      commands?: readonly string[];
      playbooks?: readonly string[];
    };
    const probe = (
      ids: readonly string[] | undefined,
      kind: SelfConfigKind,
      lookup: Set<string>,
    ): void => {
      if (!ids) return;
      for (const id of ids) {
        if (lookup.has(id)) continue;
        pushFinding(findings, {
          severity: SelfConfigSeverityV2.Info,
          code: `routing-hint-${kind}-missing`,
          sourceKind: 'routing-hint',
          sourceId: e.hint.id,
          targetKind: kind,
          targetId: id,
          relation: 'routes-to',
          message: `Routing hint "${e.hint.id}" recommends ${kind} "${id}" but it is not registered.`,
        });
      }
    };
    probe(rec.templates, 'template', lookups.templates);
    probe(rec.helpers, 'helper', lookups.helpers);
    probe(rec.conventions, 'convention', lookups.conventions);
    probe(rec.profiles, 'profile', lookups.migrationProfiles);
    probe(rec.commands, 'command', lookups.commands);
    probe(rec.playbooks, 'playbook', lookups.playbooks);
  }
}

// ─── 6. Pipelines → templates / commands (via cliCommands) ────────────────

function checkPipelines(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): void {
  const pipelines =
    inspection.pipelineRegistry?.list?.() ??
    ((inspection.pipelines ?? []) as readonly {
      id: string;
      steps?: readonly {
        id: string;
        cliCommands?: readonly string[];
        references?: readonly string[];
      }[];
      source?: { origin?: string };
    }[]);
  for (const p of pipelines as readonly {
    id: string;
    steps?: readonly {
      id: string;
      cliCommands?: readonly string[];
      references?: readonly string[];
    }[];
    source?: { origin?: string };
  }[]) {
    for (const step of p.steps ?? []) {
      // Templates referenced by id should resolve.
      for (const ref of step.references ?? []) {
        if (
          lookups.templates.has(ref) ||
          lookups.knowledge.has(ref) ||
          lookups.conventions.has(ref) ||
          lookups.paths.has(ref) ||
          lookups.helpers.has(ref)
        )
          continue;
        pushFinding(findings, {
          severity: SelfConfigSeverityV2.Info,
          code: 'pipeline-reference-missing',
          sourceKind: 'pipeline',
          sourceId: p.id,
          targetKind: 'unknown',
          targetId: ref,
          relation: 'references',
          file: p.source?.origin ?? undefined,
          message: `Pipeline "${p.id}" step "${step.id}" references unknown id "${ref}".`,
          confidence: 'medium',
        });
      }
    }
  }
}

// ─── 7. Playbooks → templates / helpers / commands / profiles ─────────────

async function checkPlaybooks(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): Promise<void> {
  let playbooks: readonly {
    id: string;
    recommendedTemplateIds?: readonly string[];
    recommendedPipelineIds?: readonly string[];
    recommendedPresetIds?: readonly string[];
    sourceFile?: string;
  }[];
  try {
    playbooks = (await listPlaybooks(inspection)) as unknown as typeof playbooks;
  } catch {
    return;
  }
  for (const p of playbooks) {
    for (const id of p.recommendedTemplateIds ?? []) {
      if (lookups.templates.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Warning,
        code: 'playbook-template-missing',
        sourceKind: 'playbook',
        sourceId: p.id,
        targetKind: 'template',
        targetId: id,
        relation: 'requires',
        file: p.sourceFile,
        message: `Playbook "${p.id}" recommends template "${id}" but it is not registered.`,
      });
    }
    for (const id of p.recommendedPipelineIds ?? []) {
      if (lookups.pipelines.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Warning,
        code: 'playbook-pipeline-missing',
        sourceKind: 'playbook',
        sourceId: p.id,
        targetKind: 'pipeline',
        targetId: id,
        relation: 'requires',
        file: p.sourceFile,
        message: `Playbook "${p.id}" recommends pipeline "${id}" but it is not registered.`,
      });
    }
  }
}

// ─── 8. Registration hints → templates / conventions / profiles ───────────

async function checkRegistrationHints(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): Promise<void> {
  const entries = await listRegistrationHints(inspection);
  for (const e of entries) {
    const h = e.hint as unknown as {
      id: string;
      relatedTemplateIds?: readonly string[];
      relatedConventionIds?: readonly string[];
      relatedProfileIds?: readonly string[];
    };
    const probe = (
      ids: readonly string[] | undefined,
      kind: SelfConfigKind,
      lookup: Set<string>,
    ): void => {
      if (!ids) return;
      for (const id of ids) {
        if (lookup.has(id)) continue;
        pushFinding(findings, {
          severity: SelfConfigSeverityV2.Info,
          code: `registration-hint-${kind}-missing`,
          sourceKind: 'registration-hint',
          sourceId: h.id,
          targetKind: kind,
          targetId: id,
          relation: 'related',
          file: e.sourceFile,
          message: `Registration hint "${h.id}" references ${kind} "${id}" but it is not registered.`,
          confidence: 'medium',
        });
      }
    };
    probe(h.relatedTemplateIds, 'template', lookups.templates);
    probe(h.relatedConventionIds, 'convention', lookups.conventions);
    probe(h.relatedProfileIds, 'profile', lookups.migrationProfiles);
  }
}

/**
 * Decision records are parsed from Markdown via the heading text; the
 * "Related ..." sections can contain prose ("(none directly — runtime gate)")
 * instead of structured ids. Filter those out so the doctor doesn't report
 * "missing policy '(none directly)'" as a broken link.
 */
function looksLikeId(value: string): boolean {
  if (!value) return false;
  if (value.length > 128) return false;
  // IDs are dotted/kebab identifiers, no spaces, parens, or punctuation.
  return /^[A-Za-z_][\w.\-]*$/.test(value);
}

// ─── 9. Decisions → related rules / commands / files / knowledge / etc. ───

function checkDecisions(
  inspection: ISharkcraftInspection,
  lookups: IIdLookupsV2,
  findings: ISelfConfigFindingV2[],
): void {
  let decisions: readonly {
    id: string;
    relatedRules: readonly string[];
    relatedPolicies: readonly string[];
    relatedConstructs: readonly string[];
    relatedFiles: readonly string[];
  }[] = [];
  try {
    decisions = listDecisions(inspection);
  } catch {
    return;
  }
  for (const d of decisions) {
    for (const id of d.relatedRules) {
      if (!looksLikeId(id) || lookups.rules.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Info,
        code: 'decision-rule-missing',
        sourceKind: 'decision',
        sourceId: d.id,
        targetKind: 'rule',
        targetId: id,
        relation: 'related',
        message: `Decision "${d.id}" references missing rule "${id}".`,
        confidence: 'medium',
      });
    }
    for (const id of d.relatedPolicies) {
      if (!looksLikeId(id) || lookups.policies.has(id)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Info,
        code: 'decision-policy-missing',
        sourceKind: 'decision',
        sourceId: d.id,
        targetKind: 'policy',
        targetId: id,
        relation: 'related',
        message: `Decision "${d.id}" references missing policy "${id}".`,
        confidence: 'medium',
      });
    }
    for (const filePath of d.relatedFiles) {
      // A "Related file" must look like a path. Skip prose.
      if (!filePath || /\s/.test(filePath.trim()) || filePath.length > 240) continue;
      const abs = nodePath.isAbsolute(filePath)
        ? filePath
        : nodePath.join(inspection.projectRoot, filePath);
      if (existsSync(abs)) continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Info,
        code: 'decision-file-missing',
        sourceKind: 'decision',
        sourceId: d.id,
        targetKind: 'file',
        targetId: filePath,
        relation: 'references',
        message: `Decision "${d.id}" references missing file "${filePath}".`,
        confidence: 'medium',
      });
    }
  }
}

// ─── 10. Stale pack signatures (surface as warning) ───────────────────────

function checkStaleSignatures(
  inspection: ISharkcraftInspection,
  findings: ISelfConfigFindingV2[],
): void {
  try {
    const inv = buildPackContributionsInventory(inspection);
    for (const c of inv.conflicts) {
      if (c.kind !== 'stale-signature') continue;
      pushFinding(findings, {
        severity: SelfConfigSeverityV2.Warning,
        code: 'pack-signature-stale',
        sourceKind: 'pack',
        sourceId: c.id,
        targetKind: 'schema',
        targetId: 'sharkcraft.pack-manifest/v1',
        relation: 'validates',
        message: c.message,
        ...(c.nextCommand ? { nextCommand: c.nextCommand } : {}),
        confidence: 'high',
      });
    }
  } catch {
    // ignore
  }
}

// ─── Public entry ─────────────────────────────────────────────────────────

export async function buildSelfConfigDoctorReportV2(
  inspection: ISharkcraftInspection,
): Promise<ISelfConfigDoctorReportV2> {
  const findings: ISelfConfigFindingV2[] = [];
  const lookups = await buildLookupsV2(inspection);

  checkKnowledgeFileRefs(inspection, findings);
  await checkSearchTuning(inspection, lookups, findings);
  await checkAgentTests(inspection, lookups, findings);
  checkTemplateMetadata(inspection, lookups, findings);
  await checkRoutingHints(inspection, lookups, findings);
  checkPipelines(inspection, lookups, findings);
  await checkPlaybooks(inspection, lookups, findings);
  await checkRegistrationHints(inspection, lookups, findings);
  checkDecisions(inspection, lookups, findings);
  checkStaleSignatures(inspection, findings);

  const totals = computeTotalsV2(findings);
  const verdict: 'ok' | 'warnings' | 'errors' =
    totals.error > 0 ? 'errors' : totals.warning > 0 ? 'warnings' : 'ok';
  const nextCommands: string[] = [];
  if (totals.error > 0) {
    nextCommands.push(
      'Fix the errored ids first — agent-test expectations and template requirements are load-bearing.',
      'shrk packs conflicts',
    );
  } else if (totals.warning > 0) {
    nextCommands.push(
      'Review warnings — most resolve by registering the missing id or removing the stale link.',
    );
  } else {
    nextCommands.push('shrk self-config doctor --schema v2 --json | jq .verdict');
  }

  return {
    schema: SELF_CONFIG_DOCTOR_V2_SCHEMA,
    generatedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    findings,
    totals,
    verdict,
    nextCommands,
  };
}

function computeTotalsV2(
  findings: readonly ISelfConfigFindingV2[],
): ISelfConfigDoctorReportV2['totals'] {
  const byRelation: Record<string, number> = {};
  const bySourceKind: Record<string, number> = {};
  const byTargetKind: Record<string, number> = {};
  let error = 0;
  let warning = 0;
  let info = 0;
  for (const f of findings) {
    byRelation[f.relation] = (byRelation[f.relation] ?? 0) + 1;
    bySourceKind[f.sourceKind] = (bySourceKind[f.sourceKind] ?? 0) + 1;
    byTargetKind[f.targetKind] = (byTargetKind[f.targetKind] ?? 0) + 1;
    if (f.severity === SelfConfigSeverityV2.Error) error += 1;
    else if (f.severity === SelfConfigSeverityV2.Warning) warning += 1;
    else info += 1;
  }
  return { error, warning, info, byRelation, bySourceKind, byTargetKind };
}

export function renderSelfConfigDoctorV2Text(report: ISelfConfigDoctorReportV2): string {
  const lines: string[] = [];
  lines.push('=== Self-config doctor (v2) ===');
  lines.push(`  schema        ${report.schema}`);
  lines.push(`  generatedAt   ${report.generatedAt}`);
  lines.push(`  verdict       ${report.verdict.toUpperCase()}`);
  lines.push(`  errors        ${report.totals.error}`);
  lines.push(`  warnings      ${report.totals.warning}`);
  lines.push(`  info          ${report.totals.info}`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('  No cross-reference issues. ✓');
    return lines.join('\n') + '\n';
  }
  for (const f of report.findings.slice(0, 200)) {
    lines.push(
      `  ${f.severity.padEnd(7)} [${f.code}] ${f.sourceKind}:${f.sourceId} ${f.relation} ${f.targetKind}:${f.targetId}`,
    );
    lines.push(`           ${f.message}`);
    if (f.suggestedFix) lines.push(`           fix: ${f.suggestedFix}`);
    if (f.nextCommand) lines.push(`           next: ${f.nextCommand}`);
  }
  if (report.findings.length > 200) {
    lines.push(`  … (${report.findings.length - 200} more)`);
  }
  if (report.nextCommands.length > 0) {
    lines.push('');
    lines.push('Next:');
    for (const c of report.nextCommands) lines.push(`  • ${c}`);
  }
  return lines.join('\n') + '\n';
}

export function renderSelfConfigDoctorV2Markdown(
  report: ISelfConfigDoctorReportV2,
): string {
  const lines: string[] = ['# Self-config doctor (v2)', ''];
  lines.push(`- schema: ${report.schema}`);
  lines.push(`- generatedAt: ${report.generatedAt}`);
  lines.push(`- verdict: **${report.verdict.toUpperCase()}**`);
  lines.push(`- errors: ${report.totals.error}`);
  lines.push(`- warnings: ${report.totals.warning}`);
  lines.push(`- info: ${report.totals.info}`);
  lines.push('');
  if (report.findings.length === 0) {
    lines.push('No cross-reference issues. ✓');
    return lines.join('\n') + '\n';
  }
  lines.push('| Severity | Source | Relation | Target | Message | Next |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const f of report.findings) {
    lines.push(
      `| ${f.severity} | \`${f.sourceKind}:${f.sourceId}\` | \`${f.relation}\` | \`${f.targetKind}:${f.targetId}\` | ${f.message} | ${f.nextCommand ?? ''} |`,
    );
  }
  return lines.join('\n') + '\n';
}
