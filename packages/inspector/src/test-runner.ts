import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { buildContext } from '@shrkcrft/context';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { buildTaskPacket } from './task-packet.ts';
import { rankKnowledgeEntries } from './task-ranker.ts';
import {
  type IAgentContractTest,
  type IContextTest,
} from './test-definitions.ts';
import { buildProjectOverview, renderOverviewText } from './project-overview.ts';
import { HELPERS } from './helper-registry.ts';
import { importModuleViaLoader } from '@shrkcrft/core';

/**
 * Pre-loaded registry id snapshots used to evaluate strict agent-test
 * expectations. The sync `runAgentContractTest` is best-effort; callers
 * should `loadAgentContractRegistries` once and pass the result for
 * accurate policy/construct membership checks.
 */
export interface IAgentContractRegistries {
  helpers: ReadonlySet<string>;
  playbooks: ReadonlySet<string>;
  policies: ReadonlySet<string>;
  constructs: ReadonlySet<string>;
  commands: ReadonlySet<string>;
  knowledge: ReadonlySet<string>;
}

export interface IContextTestDiagnostic {
  /** The missing or unexpected id. */
  id: string;
  /** Whether the entry exists in the project at all (it just didn't make the context). */
  existsInRegistry: boolean;
  /** Top-ranked alternatives the ranker chose instead, with reasons. */
  topAlternatives?: { id: string; score: number; reasons: readonly string[] }[];
  /** Concrete suggestions to make this test pass. */
  suggestions: readonly string[];
}

export interface IContextTestResult {
  id: string;
  task: string;
  passed: boolean;
  presentInclude: readonly string[];
  missingInclude: readonly string[];
  unexpectedInclude: readonly string[];
  totalTokens: number;
  maxTokens: number;
  failureSummary?: string;
  /** Per-missing/unexpected-id diagnostic notes. Only populated on failures. */
  diagnostics?: readonly IContextTestDiagnostic[];
}

export interface IAgentContractMissingDiagnostic {
  id: string;
  /** Which expectation slot the id was missing from. */
  kind:
    | 'template'
    | 'rule'
    | 'pipeline'
    | 'forbidden-action'
    | 'verification-command'
    | 'helper'
    | 'playbook'
    | 'policy'
    | 'construct'
    | 'command'
    | 'knowledge'
    | 'must-not-include';
  existsInRegistry: boolean;
  suggestions: readonly string[];
}

export interface IAgentContractTestResult {
  id: string;
  task: string;
  passed: boolean;
  expectedPipeline?: string;
  actualPipelines?: readonly string[];
  missingTemplates?: readonly string[];
  missingRules?: readonly string[];
  missingForbiddenActions?: readonly string[];
  missingVerificationCommands?: readonly string[];
  /** Strict expectation field results. */
  missingHelpers?: readonly string[];
  missingPlaybooks?: readonly string[];
  missingPolicies?: readonly string[];
  missingConstructs?: readonly string[];
  missingCommands?: readonly string[];
  missingKnowledge?: readonly string[];
  /** Ids that should NOT have been surfaced but were. */
  unexpectedlyIncluded?: readonly string[];
  failureSummary?: string;
  diagnostics?: readonly IAgentContractMissingDiagnostic[];
}

async function importDefaultArray(absPath: string): Promise<unknown[]> {
  if (!existsSync(absPath)) return [];
  try {
    const mod = (await importModuleViaLoader(absPath)) as { default?: unknown };
    return Array.isArray(mod.default) ? (mod.default as unknown[]) : [];
  } catch {
    return [];
  }
}

/**
 * Load context tests from local sharkcraft config + any pack contributions.
 */
export async function loadContextTests(
  inspection: ISharkcraftInspection,
): Promise<IContextTest[]> {
  const tests: IContextTest[] = [];
  // Local config file.
  if (inspection.sharkcraftDir) {
    const local = nodePath.join(inspection.sharkcraftDir, 'context-tests.ts');
    if (existsSync(local)) {
      tests.push(...((await importDefaultArray(local)) as IContextTest[]));
    }
  }
  // Pack contributions.
  for (const pack of inspection.packs.validPacks) {
    const c = pack.manifest!.contributions as { contextTestFiles?: readonly string[] };
    for (const rel of c.contextTestFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      tests.push(...((await importDefaultArray(full)) as IContextTest[]));
    }
  }
  return tests;
}

export async function loadAgentContractTests(
  inspection: ISharkcraftInspection,
): Promise<IAgentContractTest[]> {
  const tests: IAgentContractTest[] = [];
  if (inspection.sharkcraftDir) {
    const local = nodePath.join(inspection.sharkcraftDir, 'agent-tests.ts');
    if (existsSync(local)) {
      tests.push(...((await importDefaultArray(local)) as IAgentContractTest[]));
    }
  }
  for (const pack of inspection.packs.validPacks) {
    const c = pack.manifest!.contributions as { agentTestFiles?: readonly string[] };
    for (const rel of c.agentTestFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      tests.push(...((await importDefaultArray(full)) as IAgentContractTest[]));
    }
  }
  return tests;
}

export function runContextTest(
  inspection: ISharkcraftInspection,
  test: IContextTest,
): IContextTestResult {
  const overview = buildProjectOverview(inspection.workspace, inspection.config?.projectName);
  const ctx = buildContext(inspection.knowledgeEntries, {
    task: test.task,
    maxTokens: test.maxTokens ?? 3500,
    projectOverview: renderOverviewText(overview),
  });
  const bodyIds = new Set<string>();
  for (const section of ctx.sections) {
    for (const id of section.entryIds) bodyIds.add(id);
  }
  const missingInclude: string[] = [];
  const presentInclude: string[] = [];
  for (const id of test.mustInclude ?? []) {
    if (bodyIds.has(id)) presentInclude.push(id);
    else missingInclude.push(id);
  }
  const unexpectedInclude: string[] = [];
  for (const id of test.mustNotInclude ?? []) {
    if (bodyIds.has(id)) unexpectedInclude.push(id);
  }
  const passed = missingInclude.length === 0 && unexpectedInclude.length === 0;

  // Diagnostics: only populate on failure. Show the top-ranked alternatives
  // the ranker chose for the task, so the test author can see what beat the
  // expected entry — and tighten the rule's appliesWhen/tags accordingly.
  let diagnostics: IContextTestDiagnostic[] | undefined;
  if (!passed) {
    const ranked = rankKnowledgeEntries(inspection.knowledgeEntries, test.task);
    diagnostics = [];
    for (const id of missingInclude) {
      const exists = inspection.knowledgeEntries.some((e) => e.id === id);
      diagnostics.push({
        id,
        existsInRegistry: exists,
        topAlternatives: ranked.slice(0, 5).map((r) => ({
          id: r.item.id,
          score: r.score,
          reasons: r.reasons,
        })),
        suggestions: buildMissingIncludeSuggestions(id, exists, test.task),
      });
    }
    for (const id of unexpectedInclude) {
      const entry = inspection.knowledgeEntries.find((e) => e.id === id);
      const reasons = ranked.find((r) => r.item.id === id)?.reasons ?? [];
      diagnostics.push({
        id,
        existsInRegistry: !!entry,
        topAlternatives: reasons.length
          ? [{ id, score: ranked.find((r) => r.item.id === id)?.score ?? 0, reasons }]
          : undefined,
        suggestions: [
          `"${id}" appeared in the context body for "${test.task}".`,
          'Narrow its `appliesWhen` to avoid matching this task wording, or remove the entry from mustNotInclude if the inclusion is acceptable.',
        ],
      });
    }
  }

  const result: IContextTestResult = {
    id: test.id,
    task: test.task,
    passed,
    presentInclude,
    missingInclude,
    unexpectedInclude,
    totalTokens: ctx.totalTokens,
    maxTokens: ctx.maxTokens,
  };
  if (!passed) {
    result.failureSummary = `missing=${missingInclude.length} unexpected=${unexpectedInclude.length}`;
  }
  if (diagnostics) result.diagnostics = diagnostics;
  return result;
}

function buildMissingIncludeSuggestions(
  id: string,
  existsInRegistry: boolean,
  task: string,
): string[] {
  if (!existsInRegistry) {
    return [
      `Entry "${id}" does not exist in the inspection — either install the pack that ships it or correct the id.`,
      `If the test expectation is wrong, update sharkcraft/context-tests.ts.`,
    ];
  }
  return [
    `Entry "${id}" exists but did not make the context for task "${task}".`,
    `Try adding domain-aligned appliesWhen values (create-plugin / generate-service / register-defaults / …).`,
    `Add task-relevant tags (plugin / capability / adapter / …).`,
    `Reference the entry from a preset's includes.knowledgeIds / ruleIds so it ranks higher.`,
    `Or raise its priority / shorten the title to include task-relevant tokens.`,
  ];
}

export function runAgentContractTest(
  inspection: ISharkcraftInspection,
  test: IAgentContractTest,
  registries?: IAgentContractRegistries,
): IAgentContractTestResult {
  const packet = buildTaskPacket(inspection, test.task, { maxTokens: 3500 });
  const actualPipelines = packet.recommendedPipelines.map((p) => p.pipelineId);
  const missingTemplates = (test.expectedTemplates ?? []).filter(
    (id) => !packet.relevantTemplates.some((t) => t.id === id),
  );
  const missingRules = (test.expectedRules ?? []).filter(
    (id) => !packet.relevantRules.some((r) => r.id === id),
  );
  const missingForbidden = (test.expectedForbiddenActions ?? []).filter(
    (a) => !packet.forbiddenActions.includes(a),
  );
  const missingVerification = (test.expectedVerificationCommands ?? []).filter(
    (c) => !packet.verificationCommands.includes(c),
  );

  // New expectation checks. Each one fails when the asset is missing
  // from the relevant registry (drift detection) or — for commands — also
  // not surfaced in the packet's recommended set.
  const helperRegistry = registries?.helpers ?? loadHelperRegistryQuietly();
  const playbookList = registries?.playbooks ?? listPlaybookIdsQuietly(inspection);
  const policyChecks = registries?.policies ?? listPolicyIdsQuietly(inspection);
  const constructList = registries?.constructs ?? listConstructIdsQuietly(inspection);
  const commandCatalog = registries?.commands ?? listCommandIdsQuietly(inspection);
  const knowledgeIds =
    registries?.knowledge ?? new Set(inspection.knowledgeEntries.map((e) => e.id));

  const missingHelpers = (test.expectedHelpers ?? []).filter(
    (id) => !helperRegistry.has(id),
  );
  const missingPlaybooks = (test.expectedPlaybooks ?? []).filter(
    (id) => !playbookList.has(id),
  );
  const missingPolicies = (test.expectedPolicies ?? []).filter(
    (id) => !policyChecks.has(id),
  );
  const missingConstructs = (test.expectedConstructs ?? []).filter(
    (id) => !constructList.has(id),
  );
  const missingCommands = (test.expectedCommands ?? []).filter((id) => {
    if (packet.recommendedCliCommands.includes(id)) return false;
    // Accept either the catalog id form ("dev start") or the bare
    // first token ("dev"). The catalog uses dotted ids that map to the
    // command shape; we accept either form.
    return !commandCatalog.has(id) && !commandCatalog.has(id.split(' ')[0]!);
  });
  const missingKnowledge = (test.expectedKnowledge ?? []).filter(
    (id) => !knowledgeIds.has(id),
  );

  // mustNotInclude — fail if any of these ids ended up surfaced in the packet.
  const surfacedIds = new Set<string>();
  for (const t of packet.relevantTemplates) surfacedIds.add(t.id);
  for (const r of packet.relevantRules) surfacedIds.add(r.id);
  for (const p of packet.relevantPaths) surfacedIds.add(p.id);
  for (const p of packet.recommendedPipelines) surfacedIds.add(p.pipelineId);
  for (const p of packet.presetRecommendations) surfacedIds.add(p.preset.id);
  const unexpectedlyIncluded = (test.mustNotInclude ?? []).filter((id) =>
    surfacedIds.has(id),
  );

  const pipelineOk =
    !test.expectedPipeline || actualPipelines.includes(test.expectedPipeline);
  const passed =
    pipelineOk &&
    missingTemplates.length === 0 &&
    missingRules.length === 0 &&
    missingForbidden.length === 0 &&
    missingVerification.length === 0 &&
    missingHelpers.length === 0 &&
    missingPlaybooks.length === 0 &&
    missingPolicies.length === 0 &&
    missingConstructs.length === 0 &&
    missingCommands.length === 0 &&
    missingKnowledge.length === 0 &&
    unexpectedlyIncluded.length === 0;
  // Diagnostics on failure: per missing id, explain whether the entry
  // exists in the registry and how to make it surface.
  let diagnostics: IAgentContractMissingDiagnostic[] | undefined;
  if (!passed) {
    diagnostics = [];
    for (const id of missingTemplates) {
      const exists = inspection.templates.some((t) => t.id === id);
      diagnostics.push({
        id,
        kind: 'template',
        existsInRegistry: exists,
        suggestions: exists
          ? [
              `Template "${id}" exists but the ranker did not place it in the top results.`,
              'Add task-aligned tags/appliesWhen to the template (e.g. tags:["plugin"], appliesWhen:["create-plugin"]).',
              'Reference the template from a preset that matches the task profile (includes.templateIds).',
              'Reference it from a pipeline step (`step.references`).',
            ]
          : [
              `Template "${id}" does not exist — install the pack that ships it or correct the id.`,
            ],
      });
    }
    for (const id of missingRules) {
      const exists = inspection.knowledgeEntries.some((e) => e.id === id);
      diagnostics.push({
        id,
        kind: 'rule',
        existsInRegistry: exists,
        suggestions: exists
          ? [
              `Rule "${id}" exists but the ranker did not surface it for "${test.task}".`,
              'Align its appliesWhen with the domain (e.g. create-plugin / register-defaults / generate-service).',
              'Add domain tags (plugin / capability / adapter / defaults).',
              'Reference it from actionHints.relatedTemplates on a rule that *is* ranking, or include it in a preset.',
            ]
          : [
              `Rule "${id}" does not exist — install the pack that ships it or correct the id.`,
            ],
      });
    }
    if (!pipelineOk && test.expectedPipeline) {
      diagnostics.push({
        id: test.expectedPipeline,
        kind: 'pipeline',
        existsInRegistry: inspection.pipelines.some((p) => p.id === test.expectedPipeline),
        suggestions: [
          `Pipeline "${test.expectedPipeline}" did not rank in the top 3 for "${test.task}".`,
          'Add domain-aligned tags to the pipeline (tags:["plugin"], …).',
          'Add task tokens to its title / description so the ranker catches them.',
          'Reference the pipeline from a preset that the task profile recommends.',
        ],
      });
    }
    for (const action of missingForbidden) {
      diagnostics.push({
        id: action,
        kind: 'forbidden-action',
        existsInRegistry: false,
        suggestions: [
          `No rule's actionHints.forbiddenActions contains "${action}" for this task's relevant set.`,
          'Add the forbiddenAction to one of the high-priority rules that match this task.',
        ],
      });
    }
    for (const cmd of missingVerification) {
      diagnostics.push({
        id: cmd,
        kind: 'verification-command',
        existsInRegistry: false,
        suggestions: [
          `Verification command "${cmd}" is not aggregated for this task.`,
          'Add it to a high-priority rule\'s actionHints.verificationCommands.',
        ],
      });
    }
    // Diagnostics for the new expectation slots.
    for (const id of missingHelpers) {
      diagnostics.push({
        id,
        kind: 'helper',
        existsInRegistry: helperRegistry.has(id),
        suggestions: [
          `Helper "${id}" not found in the helper registry — install the pack that ships it or correct the id.`,
          'Make sure the helper is registered in HELPERS in packages/inspector/src/helper-registry.ts (or a pack contribution).',
        ],
      });
    }
    for (const id of missingPlaybooks) {
      diagnostics.push({
        id,
        kind: 'playbook',
        existsInRegistry: playbookList.has(id),
        suggestions: [
          `Playbook "${id}" not found in the playbook registry — install the pack that ships it or correct the id.`,
          'Ensure the playbook file is referenced in sharkcraft.config.ts / pack contributions and exports a default array.',
        ],
      });
    }
    for (const id of missingPolicies) {
      diagnostics.push({
        id,
        kind: 'policy',
        existsInRegistry: policyChecks.has(id),
        suggestions: [
          `Policy "${id}" not found in the policy-engine checks — install the pack that ships it or correct the id.`,
          'Add it to sharkcraft/policies.ts or a pack policyCheckFile.',
        ],
      });
    }
    for (const id of missingConstructs) {
      diagnostics.push({
        id,
        kind: 'construct',
        existsInRegistry: constructList.has(id),
        suggestions: [
          `Construct "${id}" not found in the construct registry — install the pack that ships it or correct the id.`,
          'Add a defineConstruct() entry in sharkcraft/constructs.ts or a pack constructFile.',
        ],
      });
    }
    for (const id of missingCommands) {
      diagnostics.push({
        id,
        kind: 'command',
        existsInRegistry: commandCatalog.has(id) || commandCatalog.has(id.split(' ')[0]!),
        suggestions: [
          `Command "${id}" was not surfaced for "${test.task}" and is not in the command catalog.`,
          'Add it to a high-priority rule\'s actionHints.commands or check the command-catalog.ts entries.',
        ],
      });
    }
    for (const id of missingKnowledge) {
      diagnostics.push({
        id,
        kind: 'knowledge',
        existsInRegistry: knowledgeIds.has(id),
        suggestions: [
          `Knowledge entry "${id}" is not present in the inspection — install the pack that ships it or correct the id.`,
        ],
      });
    }
    for (const id of unexpectedlyIncluded) {
      diagnostics.push({
        id,
        kind: 'must-not-include',
        existsInRegistry: true,
        suggestions: [
          `"${id}" was surfaced by the ranker but the test forbids it.`,
          'Narrow its appliesWhen / tags to avoid matching this task wording.',
        ],
      });
    }
  }

  const result: IAgentContractTestResult = {
    id: test.id,
    task: test.task,
    passed,
    actualPipelines,
    missingTemplates,
    missingRules,
    missingForbiddenActions: missingForbidden,
    missingVerificationCommands: missingVerification,
    missingHelpers,
    missingPlaybooks,
    missingPolicies,
    missingConstructs,
    missingCommands,
    missingKnowledge,
    unexpectedlyIncluded,
  };
  if (test.expectedPipeline) result.expectedPipeline = test.expectedPipeline;
  if (!passed) {
    const partsList = [
      `pipelineOk=${pipelineOk}`,
      `missingTemplates=${missingTemplates.length}`,
      `missingRules=${missingRules.length}`,
      `missingHelpers=${missingHelpers.length}`,
      `missingPlaybooks=${missingPlaybooks.length}`,
      `missingPolicies=${missingPolicies.length}`,
      `missingConstructs=${missingConstructs.length}`,
      `missingCommands=${missingCommands.length}`,
      `missingKnowledge=${missingKnowledge.length}`,
      `unexpectedlyIncluded=${unexpectedlyIncluded.length}`,
    ];
    result.failureSummary = partsList.join(' ');
  }
  if (diagnostics) result.diagnostics = diagnostics;
  return result;
}

// ── Registry helpers ────────────────────────────────────────────────

function loadHelperRegistryQuietly(): Set<string> {
  try {
    return new Set(HELPERS.map((h) => h.id));
  } catch {
    return new Set();
  }
}

function listPlaybookIdsQuietly(inspection: ISharkcraftInspection): Set<string> {
  const reg = (inspection as { playbookRegistry?: { list?: () => readonly { id: string }[] } })
    .playbookRegistry;
  if (!reg || typeof reg.list !== 'function') return new Set();
  try {
    return new Set(reg.list().map((p) => p.id));
  } catch {
    return new Set();
  }
}

function listPolicyIdsQuietly(inspection: ISharkcraftInspection): Set<string> {
  const checks =
    (inspection as { policyChecks?: readonly { id: string }[] }).policyChecks ?? [];
  return new Set(checks.map((c) => c.id));
}

function listConstructIdsQuietly(inspection: ISharkcraftInspection): Set<string> {
  const direct = (inspection as { constructs?: readonly { id: string }[] }).constructs;
  if (direct && direct.length > 0) return new Set(direct.map((c) => c.id));
  const reg = (inspection as { constructRegistry?: { list?: () => readonly { id: string }[] } })
    .constructRegistry;
  if (reg && typeof reg.list === 'function') {
    try {
      return new Set(reg.list().map((c) => c.id));
    } catch {
      return new Set();
    }
  }
  return new Set();
}

function listCommandIdsQuietly(inspection: ISharkcraftInspection): Set<string> {
  const cat =
    (inspection as { commandCatalog?: readonly { id?: string; command?: string }[] }).commandCatalog ?? [];
  const out = new Set<string>();
  for (const c of cat) {
    if (c.id) out.add(c.id);
    if (c.command) out.add(c.command);
  }
  return out;
}

/**
 * Async pre-loader for agent-contract test registries. Reads local
 * sharkcraft/policies.ts, sharkcraft/constructs.ts, sharkcraft/playbooks/
 * (and pack contributions where present). Result is sync-friendly so the
 * runner can stay sync.
 */
export async function loadAgentContractRegistries(
  inspection: ISharkcraftInspection,
): Promise<IAgentContractRegistries> {
  return {
    helpers: loadHelperRegistryQuietly(),
    playbooks: await loadPlaybookIdsAsync(inspection),
    policies: await loadPolicyIdsAsync(inspection),
    constructs: await loadConstructIdsAsync(inspection),
    commands: listCommandIdsQuietly(inspection),
    knowledge: new Set(inspection.knowledgeEntries.map((e) => e.id)),
  };
}

async function importDefaultIdsArray(absPath: string): Promise<readonly { id: string }[]> {
  if (!existsSync(absPath)) return [];
  try {
    const mod = (await importModuleViaLoader(absPath)) as {
      default?: readonly { id: string }[];
    };
    return Array.isArray(mod.default) ? mod.default : [];
  } catch {
    return [];
  }
}

async function loadPolicyIdsAsync(inspection: ISharkcraftInspection): Promise<Set<string>> {
  const out = new Set<string>();
  if (inspection.sharkcraftDir) {
    const local = nodePath.join(inspection.sharkcraftDir, 'policies.ts');
    for (const entry of await importDefaultIdsArray(local)) {
      if (entry?.id) out.add(entry.id);
    }
  }
  for (const pack of inspection.packs.validPacks) {
    const c = pack.manifest!.contributions as { policyCheckFiles?: readonly string[] };
    for (const rel of c.policyCheckFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      for (const entry of await importDefaultIdsArray(full)) {
        if (entry?.id) out.add(entry.id);
      }
    }
  }
  // Also include any policyChecks already on the inspection (sync fallback).
  for (const id of listPolicyIdsQuietly(inspection)) out.add(id);
  return out;
}

async function loadPlaybookIdsAsync(inspection: ISharkcraftInspection): Promise<Set<string>> {
  const out = new Set<string>();
  // Sync fallback from registry.
  for (const id of listPlaybookIdsQuietly(inspection)) out.add(id);
  // Local file.
  if (inspection.sharkcraftDir) {
    const local = nodePath.join(inspection.sharkcraftDir, 'playbooks.ts');
    for (const entry of await importDefaultIdsArray(local)) {
      if (entry?.id) out.add(entry.id);
    }
  }
  // Pack contributions.
  for (const pack of inspection.packs.validPacks) {
    const c = pack.manifest!.contributions as { playbookFiles?: readonly string[] };
    for (const rel of c.playbookFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      for (const entry of await importDefaultIdsArray(full)) {
        if (entry?.id) out.add(entry.id);
      }
    }
  }
  return out;
}

async function loadConstructIdsAsync(inspection: ISharkcraftInspection): Promise<Set<string>> {
  const out = new Set<string>();
  // Sync fallback first.
  for (const id of listConstructIdsQuietly(inspection)) out.add(id);
  if (inspection.sharkcraftDir) {
    const local = nodePath.join(inspection.sharkcraftDir, 'constructs.ts');
    for (const entry of await importDefaultIdsArray(local)) {
      if (entry?.id) out.add(entry.id);
    }
  }
  for (const pack of inspection.packs.validPacks) {
    const c = pack.manifest!.contributions as { constructFiles?: readonly string[] };
    for (const rel of c.constructFiles ?? []) {
      const full = nodePath.resolve(pack.packageRoot, rel);
      for (const entry of await importDefaultIdsArray(full)) {
        if (entry?.id) out.add(entry.id);
      }
    }
  }
  return out;
}
