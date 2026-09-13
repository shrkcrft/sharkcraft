import { existsSync } from 'node:fs';
import * as nodePath from 'node:path';
import { buildContext } from '@shrkcrft/context';
import type { ISharkcraftInspection } from './sharkcraft-inspector.ts';
import { buildTaskPacket } from './task-packet.ts';
import { rankKnowledgeEntries } from './task-ranker.ts';
import { contextTuningBoostFor } from './context-tuning.ts';
import {
  type IAgentContractTest,
  type IContextTest,
} from './test-definitions.ts';
import { buildProjectOverview, renderOverviewText } from './project-overview.ts';
import { importModuleViaLoader, RejectionCause, type IRejectedEntry } from '@shrkcrft/core';
import type { IContributionFileIssue } from './i-contribution-file-issue.ts';
import { CommandResolutionStatus } from './command-resolution-status.ts';
import type { IReferenceWarmOptions } from './i-reference-warm-options.ts';
import {
  COMMAND_INDEX_NOT_INJECTED,
  isCacheBackedKind,
  isCommandResolved,
  isReferenceCacheWarm,
  referenceIdExists,
  referenceIdsFor,
  resolveShrkCommandReference,
  warmReferenceRegistries,
  type ReferenceKind,
} from './reference-registry.ts';

/**
 * Registry id snapshots.
 *
 * @deprecated The runners no longer keep a private id source: every existence
 * check goes through the shared reference registry (`referenceIdExists`), the
 * same authority `shrk <kind> list` prints — call `warmReferenceRegistries`
 * (the CLI: `warmCliReferenceRegistries`) before running. This snapshot is kept
 * for API compatibility; its sets are projections of that registry and
 * `commands` is always empty (commands resolve through the injected resolver).
 */
export interface IAgentContractRegistries {
  helpers: ReadonlySet<string>;
  playbooks: ReadonlySet<string>;
  policies: ReadonlySet<string>;
  constructs: ReadonlySet<string>;
  commands: ReadonlySet<string>;
  knowledge: ReadonlySet<string>;
}

/** The registry a test diagnostic consulted, so a failure names what was searched. */
export interface ITestConsultedRegistry {
  /** Reference kind (`rule`, `template`, …) or `command`. */
  kind: string;
  /** The verb that prints this registry (`shrk rules list`). */
  listVerb: string;
  /** How many ids it holds right now (0 for `command`, which resolves rather than lists). */
  size: number;
}

export interface IContextTestDiagnostic {
  /** The missing or unexpected id. */
  id: string;
  /** Whether the entry exists in the project at all (it just didn't make the context). */
  existsInRegistry: boolean;
  /** The registry `existsInRegistry` was answered from. */
  consulted?: ITestConsultedRegistry;
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
  /**
   * What the expectation asserts:
   *   - `surfaced` — the ranker put it in this task's packet (order-sensitive;
   *     may flip on an unrelated content edit);
   *   - `exists`   — it is registered (stable).
   */
  assertion?: 'surfaced' | 'exists';
  /**
   * Why it failed:
   *   - `unknown-id`             — not registered at all: the test can never pass;
   *   - `not-surfaced`           — registered, but the ranker did not surface it;
   *   - `unknown-command`        — the command string does not resolve (see `closest`);
   *   - `unverifiable`           — the lookup could not run (registries not warmed,
   *                                or no command index injected outside the CLI);
   *   - `not-aggregated`         — no relevant rule contributes this action/command;
   *   - `surfaced-but-forbidden` — `mustNotInclude`, and the ranker surfaced it.
   */
  code?:
    | 'unknown-id'
    | 'not-surfaced'
    | 'unknown-command'
    | 'unverifiable'
    | 'not-aggregated'
    | 'surfaced-but-forbidden';
  /** The registry the existence answer came from. */
  consulted?: ITestConsultedRegistry;
  /** Nearest real commands, for `unknown-command`. */
  closest?: readonly string[];
  suggestions: readonly string[];
}

export interface IAgentContractTestResult {
  id: string;
  task: string;
  passed: boolean;
  /**
   * `pass`, `fail`, or `not-verified` when every failing expectation is one the
   * runner could not evaluate (see diagnostic code `unverifiable`). `passed` is
   * false for `not-verified`: an unmeasured expectation is never a pass.
   */
  verdict: 'pass' | 'fail' | 'not-verified';
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
  /** `<kind>:<id>` expectations the runner could not evaluate. */
  unverified?: readonly string[];
  failureSummary?: string;
  diagnostics?: readonly IAgentContractMissingDiagnostic[];
}

/** The `list` verb that prints each registry — named in every diagnostic. */
const LIST_VERBS: Readonly<Record<string, string>> = Object.freeze({
  template: 'shrk templates list',
  rule: 'shrk rules list',
  pipeline: 'shrk pipelines list',
  helper: 'shrk helper list',
  playbook: 'shrk playbooks list',
  policy: 'shrk policy list',
  construct: 'shrk constructs list',
  knowledge: 'shrk knowledge list',
  command: 'shrk surface list',
});

function consulted(inspection: ISharkcraftInspection, kind: ReferenceKind): ITestConsultedRegistry {
  return {
    kind,
    listVerb: LIST_VERBS[kind] ?? `shrk ${kind} list`,
    size: kind === 'command' ? 0 : referenceIdsFor(inspection, kind).length,
  };
}

/**
 * THE existence answer for a test expectation — the shared reference registry,
 * never a private set. A cache-backed kind read before the registries were
 * warmed is `unverifiable`, not "your correct id does not exist".
 */
function existence(
  inspection: ISharkcraftInspection,
  kind: ReferenceKind,
  id: string,
): 'exists' | 'missing' | 'unverifiable' {
  if (referenceIdExists(inspection, kind, id)) return 'exists';
  if (isCacheBackedKind(kind) && !isReferenceCacheWarm(inspection)) return 'unverifiable';
  return 'missing';
}

/** A test file's default array; `error` (first line) when the import threw. A missing file is `[]`. */
async function importDefaultArray(absPath: string): Promise<{ items: readonly unknown[]; error?: string }> {
  if (!existsSync(absPath)) return { items: [] };
  try {
    const mod = (await importModuleViaLoader(absPath)) as { default?: unknown };
    return { items: Array.isArray(mod.default) ? (mod.default as unknown[]) : [] };
  } catch (e) {
    return { items: [], error: ((e as Error).message ?? String(e)).split('\n')[0]!.trim() };
  }
}

/**
 * THE context / agent-contract test acceptance predicate (round 12, 12.1): a
 * non-empty string `id` and a string `task` — `[]` means accepted. Tests used
 * to load with no per-entry validation (a test without a `task` ran against
 * `undefined`), and a file that failed to import became `[]` in silence.
 */
export function testDefinitionRejectionReasons(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['(entry): must be an object'];
  const t = raw as Record<string, unknown>;
  const out: string[] = [];
  if (typeof t.id !== 'string' || t.id.length === 0) out.push('id: must be a non-empty string');
  if (typeof t.task !== 'string') out.push('task: must be a string');
  return out;
}

async function loadTestDefinitions<T>(
  inspection: ISharkcraftInspection,
  localName: string,
  slot: 'contextTestFiles' | 'agentTestFiles',
): Promise<{
  tests: T[];
  entries: { readonly id: string; readonly file: string; readonly packageName?: string }[];
  issues: IContributionFileIssue[];
  rejected: IRejectedEntry[];
}> {
  const tests: T[] = [];
  const entries: { readonly id: string; readonly file: string; readonly packageName?: string }[] = [];
  const issues: IContributionFileIssue[] = [];
  const rejected: IRejectedEntry[] = [];
  const readInto = async (file: string, packageName?: string): Promise<void> => {
    const r = await importDefaultArray(file);
    const rel = nodePath.relative(inspection.projectRoot, file) || file;
    if (r.error !== undefined) {
      issues.push({
        severity: 'warning',
        code: 'load-failed',
        message: `${packageName ? `Pack ${packageName} (${rel})` : `Failed to load ${rel}`}: ${r.error}`,
        source: file,
        ...(packageName ? { packageName } : {}),
      });
      return;
    }
    r.items.forEach((item, index) => {
      const reasons = testDefinitionRejectionReasons(item);
      if (reasons.length > 0) {
        const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
        rejected.push({
          file,
          index,
          exportName: 'default',
          ...(typeof id === 'string' && id.length > 0 ? { entryId: id } : {}),
          reasons,
          cause: RejectionCause.Invalid,
        });
        return;
      }
      tests.push(item as T);
      entries.push({ id: (item as { id: string }).id, file, ...(packageName ? { packageName } : {}) });
    });
  };
  // Local config file.
  if (inspection.sharkcraftDir) {
    const local = nodePath.join(inspection.sharkcraftDir, localName);
    if (existsSync(local)) await readInto(local);
  }
  // Pack contributions.
  for (const pack of inspection.packs.validPacks) {
    const c = pack.manifest!.contributions as Readonly<Record<string, readonly string[] | undefined>>;
    for (const rel of c[slot] ?? []) await readInto(nodePath.resolve(pack.packageRoot, rel), pack.packageName);
  }
  return { tests, entries, issues, rejected };
}

/**
 * Context tests WITH what did not take effect (round 12, 12.1): files that
 * failed to import and every declared test the loader refused.
 */
export async function loadContextTestsWithIssues(inspection: ISharkcraftInspection): Promise<{
  readonly tests: readonly IContextTest[];
  readonly entries: readonly { readonly id: string; readonly file: string; readonly packageName?: string }[];
  readonly issues: readonly IContributionFileIssue[];
  readonly rejected: readonly IRejectedEntry[];
}> {
  return loadTestDefinitions<IContextTest>(inspection, 'context-tests.ts', 'contextTestFiles');
}

/** Agent-contract tests WITH what did not take effect (round 12, 12.1). */
export async function loadAgentContractTestsWithIssues(inspection: ISharkcraftInspection): Promise<{
  readonly tests: readonly IAgentContractTest[];
  readonly entries: readonly { readonly id: string; readonly file: string; readonly packageName?: string }[];
  readonly issues: readonly IContributionFileIssue[];
  readonly rejected: readonly IRejectedEntry[];
}> {
  return loadTestDefinitions<IAgentContractTest>(inspection, 'agent-tests.ts', 'agentTestFiles');
}

/**
 * Load context tests from local sharkcraft config + any pack contributions.
 */
export async function loadContextTests(
  inspection: ISharkcraftInspection,
): Promise<IContextTest[]> {
  return [...(await loadContextTestsWithIssues(inspection)).tests];
}

export async function loadAgentContractTests(
  inspection: ISharkcraftInspection,
): Promise<IAgentContractTest[]> {
  return [...(await loadAgentContractTestsWithIssues(inspection)).tests];
}

export function runContextTest(
  inspection: ISharkcraftInspection,
  test: IContextTest,
): IContextTestResult {
  const overview = buildProjectOverview(inspection.workspace, inspection.config?.projectName);
  const boostFor = contextTuningBoostFor(inspection, test.task);
  const ctx = buildContext(inspection.knowledgeEntries, {
    task: test.task,
    maxTokens: test.maxTokens ?? 3500,
    projectOverview: renderOverviewText(overview),
    ...(boostFor ? { boostFor } : {}),
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
  // `mustInclude` is a RANKER-SURFACED assertion; whether the id exists at all
  // is answered by the shared registry, the set `shrk knowledge list` prints.
  let diagnostics: IContextTestDiagnostic[] | undefined;
  if (!passed) {
    const ranked = rankKnowledgeEntries(inspection.knowledgeEntries, test.task);
    const knowledgeRegistry = consulted(inspection, 'knowledge');
    diagnostics = [];
    for (const id of missingInclude) {
      const exists = referenceIdExists(inspection, 'knowledge', id);
      diagnostics.push({
        id,
        existsInRegistry: exists,
        consulted: knowledgeRegistry,
        topAlternatives: ranked.slice(0, 5).map((r) => ({
          id: r.item.id,
          score: r.score,
          reasons: r.reasons,
        })),
        suggestions: buildMissingIncludeSuggestions(id, exists, test.task, knowledgeRegistry),
      });
    }
    for (const id of unexpectedInclude) {
      const reasons = ranked.find((r) => r.item.id === id)?.reasons ?? [];
      diagnostics.push({
        id,
        existsInRegistry: referenceIdExists(inspection, 'knowledge', id),
        consulted: knowledgeRegistry,
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
  registry: ITestConsultedRegistry,
): string[] {
  if (!existsInRegistry) {
    return [
      `Entry "${id}" is not in the knowledge registry (the ${registry.size} ids \`${registry.listVerb}\` prints) — this expectation can never pass. Install the pack that ships it or correct the id.`,
      `If the test expectation is wrong, update sharkcraft/context-tests.ts.`,
    ];
  }
  return [
    `Entry "${id}" exists but did not make the context for task "${task}".`,
    `Try adding domain-aligned appliesWhen values (generate-service / generate-utility / create-pipeline / …).`,
    `Add task-relevant tags (service / utility / route / …).`,
    `Reference the entry from a preset's includes.knowledgeIds / ruleIds so it ranks higher.`,
    `Or raise its priority / shorten the title to include task-relevant tokens.`,
  ];
}

export function runAgentContractTest(
  inspection: ISharkcraftInspection,
  test: IAgentContractTest,
  /** @deprecated Ignored — existence resolves through the shared reference registry. */
  _registries?: IAgentContractRegistries,
): IAgentContractTestResult {
  // Self-tests assert specific rules/templates appear for a task — they
  // test semantics, not packet size. Opt out of the compact cap so the
  // assertions see the full ranking.
  const packet = buildTaskPacket(inspection, test.task, { maxTokens: 3500, compact: false });
  const actualPipelines = packet.recommendedPipelines.map((p) => p.pipelineId);

  // ── Ranker-SURFACED expectations (order-sensitive) ─────────────────────
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

  // ── Registry-EXISTENCE expectations (stable) ───────────────────────────
  // One authority: the shared reference registry. The runner used to keep a
  // parallel resolver (a `*Quietly` helper per kind) whose helper set missed
  // pack helpers, and whose command set read a property no inspection has —
  // so every correct `expectedCommands` entry failed.
  const unverified: string[] = [];
  const unverifiedIds = new Set<string>();
  const existsCheck = (kind: ReferenceKind, ids: readonly string[] | undefined): string[] => {
    const missing: string[] = [];
    for (const id of ids ?? []) {
      const status = existence(inspection, kind, id);
      if (status === 'exists') continue;
      missing.push(id);
      if (status === 'unverifiable') {
        unverified.push(`${kind}:${id}`);
        unverifiedIds.add(`${kind}:${id}`);
      }
    }
    return missing;
  };
  const missingHelpers = existsCheck('helper', test.expectedHelpers);
  const missingPlaybooks = existsCheck('playbook', test.expectedPlaybooks);
  const missingPolicies = existsCheck('policy', test.expectedPolicies);
  const missingConstructs = existsCheck('construct', test.expectedConstructs);
  const missingKnowledge = existsCheck('knowledge', test.expectedKnowledge);

  // ── Commands: surfaced by the packet, OR a command that really resolves ─
  const missingCommands: string[] = [];
  const commandDiagnostics: IAgentContractMissingDiagnostic[] = [];
  for (const cmd of test.expectedCommands ?? []) {
    if (packet.recommendedCliCommands.includes(cmd)) continue;
    // A command REFERENCE: the bare catalog form (`dev start`) is read as
    // `shrk dev start` by the one resolver — no private normalisation here.
    const resolution = resolveShrkCommandReference(inspection, cmd);
    if (resolution.status === CommandResolutionStatus.Unverified) {
      missingCommands.push(cmd);
      unverified.push(`command:${cmd}`);
      unverifiedIds.add(`command:${cmd}`);
      commandDiagnostics.push({
        id: cmd,
        kind: 'command',
        existsInRegistry: false,
        assertion: 'exists',
        code: 'unverifiable',
        consulted: consulted(inspection, 'command'),
        suggestions: [
          `Command "${cmd}" was not surfaced for "${test.task}", and it could not be resolved: ${COMMAND_INDEX_NOT_INJECTED}.`,
          'Run the test through the CLI (`shrk test agent`), which injects the live command index.',
        ],
      });
      continue;
    }
    if (isCommandResolved(resolution)) continue;
    missingCommands.push(cmd);
    commandDiagnostics.push({
      id: cmd,
      kind: 'command',
      existsInRegistry: false,
      assertion: 'exists',
      code: 'unknown-command',
      consulted: consulted(inspection, 'command'),
      ...(resolution.closest && resolution.closest.length > 0 ? { closest: resolution.closest } : {}),
      suggestions: [
        `Command "${cmd}" does not resolve (${resolution.status}${resolution.reason ? ` — ${resolution.reason}` : ''}) — this expectation can never pass.`,
        resolution.closest && resolution.closest.length > 0
          ? `Did you mean \`${resolution.closest[0]}\`?`
          : 'Run `shrk surface list` for every real command.',
      ],
    });
  }

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
  const failing =
    (pipelineOk ? 0 : 1) +
    missingTemplates.length +
    missingRules.length +
    missingForbidden.length +
    missingVerification.length +
    missingHelpers.length +
    missingPlaybooks.length +
    missingPolicies.length +
    missingConstructs.length +
    missingCommands.length +
    missingKnowledge.length +
    unexpectedlyIncluded.length;
  const passed = failing === 0;
  const verdict: IAgentContractTestResult['verdict'] = passed
    ? 'pass'
    : failing === unverified.length
      ? 'not-verified'
      : 'fail';

  // Diagnostics on failure: per missing id, whether it exists, WHICH registry
  // said so, and how to make it surface.
  let diagnostics: IAgentContractMissingDiagnostic[] | undefined;
  if (!passed) {
    diagnostics = [];
    const surfacedDiagnostic = (
      kind: 'template' | 'rule' | 'pipeline',
      id: string,
      whenExists: readonly string[],
    ): IAgentContractMissingDiagnostic => {
      const exists = referenceIdExists(inspection, kind, id);
      const registry = consulted(inspection, kind);
      const label = kind[0]!.toUpperCase() + kind.slice(1);
      return {
        id,
        kind,
        existsInRegistry: exists,
        assertion: 'surfaced',
        code: exists ? 'not-surfaced' : 'unknown-id',
        consulted: registry,
        suggestions: exists
          ? whenExists
          : [
              `${label} "${id}" is not registered — it is not among the ${registry.size} ids \`${registry.listVerb}\` prints, so this expectation can never pass.`,
              'Install the pack that ships it or correct the id.',
            ],
      };
    };
    for (const id of missingTemplates) {
      diagnostics.push(
        surfacedDiagnostic('template', id, [
          `Template "${id}" exists but the ranker did not place it in the top results.`,
          'Add task-aligned tags/appliesWhen to the template (e.g. tags:["service"], appliesWhen:["generate-service"]).',
          'Reference the template from a preset that matches the task profile (includes.templateIds).',
          'Reference it from a pipeline step (`step.references`).',
        ]),
      );
    }
    for (const id of missingRules) {
      // The RULE registry (what `shrk rules list` prints) — it used to be the
      // knowledge entries, so a knowledge-but-not-rule id was told "exists but
      // not surfaced", a permanently red test with a false hint.
      diagnostics.push(
        surfacedDiagnostic('rule', id, [
          `Rule "${id}" exists but the ranker did not surface it for "${test.task}".`,
          'Align its appliesWhen with the domain (e.g. generate-service / generate-utility / create-pipeline).',
          'Add domain tags (service / utility / route / pipeline).',
          'Reference it from actionHints.relatedTemplates on a rule that *is* ranking, or include it in a preset.',
        ]),
      );
    }
    if (!pipelineOk && test.expectedPipeline) {
      diagnostics.push(
        surfacedDiagnostic('pipeline', test.expectedPipeline, [
          `Pipeline "${test.expectedPipeline}" did not rank in the top 3 for "${test.task}".`,
          'Add domain-aligned tags to the pipeline (tags:["plugin"], …).',
          'Add task tokens to its title / description so the ranker catches them.',
          'Reference the pipeline from a preset that the task profile recommends.',
        ]),
      );
    }
    for (const action of missingForbidden) {
      diagnostics.push({
        id: action,
        kind: 'forbidden-action',
        existsInRegistry: false,
        assertion: 'surfaced',
        code: 'not-aggregated',
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
        assertion: 'surfaced',
        code: 'not-aggregated',
        suggestions: [
          `Verification command "${cmd}" is not aggregated for this task.`,
          'Add it to a high-priority rule\'s actionHints.verificationCommands.',
        ],
      });
    }
    const existsDiagnostic = (
      kind: 'helper' | 'playbook' | 'policy' | 'construct' | 'knowledge',
      id: string,
      hint: string,
    ): IAgentContractMissingDiagnostic => {
      const registry = consulted(inspection, kind);
      const cold = unverifiedIds.has(`${kind}:${id}`);
      return {
        id,
        kind,
        existsInRegistry: false,
        assertion: 'exists',
        code: cold ? 'unverifiable' : 'unknown-id',
        consulted: registry,
        suggestions: cold
          ? [
              `The ${kind} registry was not warmed, so "${id}" could not be looked up — NOT VERIFIED.`,
              'Call warmReferenceRegistries(inspection) before running agent tests.',
            ]
          : [
              `${kind[0]!.toUpperCase() + kind.slice(1)} "${id}" is not registered — it is not among the ${registry.size} ids \`${registry.listVerb}\` prints.`,
              hint,
            ],
      };
    };
    for (const id of missingHelpers) {
      diagnostics.push(
        existsDiagnostic('helper', id, 'Register it in HELPERS (packages/inspector/src/helper-registry.ts) or ship it from a pack helperFiles contribution.'),
      );
    }
    for (const id of missingPlaybooks) {
      diagnostics.push(
        existsDiagnostic('playbook', id, 'Ensure the playbook file is referenced in sharkcraft.config.ts / pack contributions and exports a default array.'),
      );
    }
    for (const id of missingPolicies) {
      diagnostics.push(
        existsDiagnostic('policy', id, 'Add it to sharkcraft/policies.ts or a pack policyCheckFile.'),
      );
    }
    for (const id of missingConstructs) {
      diagnostics.push(
        existsDiagnostic('construct', id, 'Add a defineConstruct() entry in sharkcraft/constructs.ts or a pack constructFile.'),
      );
    }
    diagnostics.push(...commandDiagnostics);
    for (const id of missingKnowledge) {
      diagnostics.push(
        existsDiagnostic('knowledge', id, 'Install the pack that ships it or correct the id.'),
      );
    }
    for (const id of unexpectedlyIncluded) {
      diagnostics.push({
        id,
        kind: 'must-not-include',
        existsInRegistry: true,
        assertion: 'surfaced',
        code: 'surfaced-but-forbidden',
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
    verdict,
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
  if (unverified.length > 0) result.unverified = unverified;
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
    if (unverified.length > 0) partsList.push(`unverified=${unverified.length}`);
    result.failureSummary = partsList.join(' ');
  }
  if (diagnostics) result.diagnostics = diagnostics;
  return result;
}

/**
 * Warm the shared reference registry and return a snapshot of it.
 *
 * @deprecated Call `warmReferenceRegistries(inspection, options)` directly (the
 * CLI: `warmCliReferenceRegistries`) — the runners read the registry itself.
 * The snapshot is a projection of that one authority, never a second source:
 * the old loader re-read policies / playbooks / constructs from its own file
 * list and returned the built-in helpers only (no pack helpers).
 */
export async function loadAgentContractRegistries(
  inspection: ISharkcraftInspection,
  options: IReferenceWarmOptions = {},
): Promise<IAgentContractRegistries> {
  await warmReferenceRegistries(inspection, options);
  const ids = (kind: ReferenceKind): ReadonlySet<string> =>
    new Set(referenceIdsFor(inspection, kind));
  return {
    helpers: ids('helper'),
    playbooks: ids('playbook'),
    policies: ids('policy'),
    constructs: ids('construct'),
    commands: new Set<string>(),
    knowledge: ids('knowledge'),
  };
}
