/**
 * `shrk delegate` — hand a mechanical, deterministically-verifiable edit to a
 * LOCAL-LLM worker, gated end-to-end by the deterministic engine.
 *
 * Flow (the worker is the ONLY stochastic step):
 *   provider.send → parseDelegateEdit → checkGuardrailGlobs → packageDelegatePlan
 *   → signPlan → savePlanToFile → (apply) verify → evaluateSavedPlanInPlace
 *   → writeSyntheticPlan → runValidationLoop → auto-revert on verify failure.
 *
 * The model never writes: its output becomes a SIGNED synthetic plan that flows
 * through the same apply primitives `shrk apply` uses. A failed verification
 * auto-reverts the edit, so a bad generation costs a retry, never a wrong write.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { containsTraversal, safeResolveTargetPath } from '@shrkcrft/core';
import {
  AiMessageRole,
  DELEGATE_ANALYSIS_JSON_SCHEMA,
  callDelegateWithRetry,
  callDelegateAnalysisWithRetry,
  delegateAnalysisRepromptMessage,
  delegateRepromptMessage,
  parseDelegateAnalysis,
  runBoundedQueryLoop,
  selectAiProvider,
  type IAiMessage,
  type IAiProvider,
  type IQueryDescriptor,
  type QueryExecutor,
} from '@shrkcrft/ai';
import { loadProjectConfig, type IDelegateRecipe, type ISharkCraftConfig } from '@shrkcrft/config';
import { compressCode, compressDiff } from '@shrkcrft/compress';
import { listIndexableFiles } from '@shrkcrft/embeddings';
import { loadGraphApiCached, type GraphQueryApi } from '@shrkcrft/graph';
import {
  analyzeTestImpact,
  buildCoverageReport,
  buildDelegateAnalysisReport,
  buildDelegateFailureFacts,
  buildTaskRiskReport,
  checkGuardrailGlobs,
  crossCheckFindings,
  inspectSharkcraft,
  resolveDelegateCatalogForProject,
  runGroundingReport,
  unifiedDiff,
  type IDelegateAnalysisReport,
  type IDelegateFailureContext,
  type IGroundingFacts,
  type IResolvedDelegateRecipe,
  type ISharkcraftInspection,
} from '@shrkcrft/inspector';
import {
  evaluateSavedPlanInPlace,
  packageDelegatePlan,
  savePlanToFile,
  signPlan,
  verifyPlan,
  writeSyntheticPlan,
  type IDroppedOp,
} from '@shrkcrft/generator';
import {
  flagBool,
  flagString,
  resolveCwd,
  type ICommandHandler,
  type ParsedArgs,
} from '../command-registry.ts';
import { asJson, header, kv } from '../output/format-output.ts';
import { runValidationLoop } from '../validation/run-validation-loop.ts';

const DEFAULT_MAX_BUDGET_MS = 60_000;

export type DelegateRunStatus =
  | 'no-provider'
  | 'generate-failed'
  | 'guardrail-refused'
  | 'package-error'
  | 'conflicts'
  | 'sign-failed'
  | 'no-verification'
  | 'generated'
  | 'applied'
  | 'apply-failed'
  | 'verify-failed';

export interface IExecuteDelegateRunInput {
  task: string;
  recipe: IDelegateRecipe;
  projectRoot: string;
  /** Injectable for tests; `null` means no local LLM is reachable. */
  provider: IAiProvider | null;
  apply: boolean;
  /** Where to write the signed plan. Default `.sharkcraft/delegate/<id>.plan.json`. */
  planPath?: string;
  /** Explicit HMAC secret. Falls back to `SHARKCRAFT_PLAN_SECRET`. */
  planSecret?: string;
  /** Validation report dir. Default `.sharkcraft/delegate/reports`. */
  reportDir?: string;
  /**
   * Optional retry advisor (Phase 2, `--assisted-retry`). Between retryable
   * failures it may return a corrected-instruction string, appended to the
   * deterministic retry feedback. Best-effort: a null return / throw is ignored,
   * so the deterministic loop is never blocked by the advisor. Injectable for
   * tests; the cli wires one from a `retry-analysis` recipe.
   */
  retryAdvisor?: (failure: IDelegateFailureContext, attempt: number) => Promise<string | null>;
}

export interface IExecuteDelegateRunResult {
  status: DelegateRunStatus;
  recipeId: string;
  message: string;
  planPath?: string;
  ops?: number;
  droppedOps?: readonly IDroppedOp[];
  refused?: readonly string[];
  conflicts?: readonly string[];
  written?: readonly string[];
  reverted?: boolean;
  verification?: { passed: boolean; commandsFailed: readonly string[] };
  usage?: { inputTokens?: number; outputTokens?: number };
  retried?: boolean;
  /** How many generate→verify attempts ran before this result (1-based). */
  attempts?: number;
  /** Compressed unified diff of what the edit changed (compact result hand-back). */
  diff?: string;
  /** CCR key when the diff was lossily compressed (recover via `shrk expand`). */
  diffCcrKey?: string;
}

/** A concrete sample op for a kind — a few-shot anchor for weak local models. */
function opExample(kind: string): { targetPath: string; operation: Record<string, unknown> } | null {
  switch (kind) {
    case 'export':
      return { targetPath: 'src/index.ts', operation: { kind: 'export', from: './health' } };
    case 'ensure-import':
      return { targetPath: 'src/service.ts', operation: { kind: 'ensure-import', from: './logger', symbols: ['log'] } };
    case 'replace':
      return { targetPath: 'src/config.ts', operation: { kind: 'replace', find: 'timeoutMs = 30000', replaceWith: 'timeoutMs = 60000', expectMatches: 1 } };
    case 'create':
      return { targetPath: 'src/new-file.ts', operation: { kind: 'create', content: 'export const x = 1;\n' } };
    case 'insert-array-entry':
      return { targetPath: 'src/registry.ts', operation: { kind: 'insert-array-entry', arrayName: 'ALL', entryValue: 'newEntry' } };
    case 'insert-enum-entry':
      return { targetPath: 'src/kinds.ts', operation: { kind: 'insert-enum-entry', enumName: 'Kind', entryName: 'NEW', entryValue: 'new' } };
    default:
      return null;
  }
}

const RECIPE_CONTEXT_FILE_CAP = 8;

/**
 * The in-scope files (current contents, compressed to signatures via the
 * code-outline pass) handed to the LOCAL worker so it can pick the right
 * targetPath, check idempotency, and find exact text to replace — instead of
 * guessing. This goes in the WORKER's prompt, read locally, so it costs the
 * orchestrator (Claude) NOTHING. Bounded to keep a small local model's context
 * focused. Returns '' when there's nothing in scope / on any error.
 */
export function gatherRecipeContext(projectRoot: string, recipe: IDelegateRecipe): string {
  let candidates: readonly string[];
  try {
    const all = listIndexableFiles(projectRoot, 3000);
    candidates = checkGuardrailGlobs(all, recipe.guardrailGlobs ?? []).allowed;
  } catch {
    return '';
  }
  if (candidates.length === 0) return '';
  const blocks: string[] = [];
  for (const rel of candidates.slice(0, RECIPE_CONTEXT_FILE_CAP)) {
    try {
      const outline = compressCode(readFileSync(nodePath.join(projectRoot, rel), 'utf8')).compressed;
      blocks.push(`## ${rel}\n${outline}`);
    } catch {
      /* skip unreadable */
    }
  }
  if (blocks.length === 0) return '';
  const more =
    candidates.length > blocks.length ? `\n\n(showing ${blocks.length} of ${candidates.length} in-scope files)` : '';
  return `Files in scope you may edit (current contents):\n\n${blocks.join('\n\n')}${more}`;
}

function systemPrompt(recipe: IDelegateRecipe): string {
  const allowedOps = recipe.allowedOps ?? [];
  const guardrailGlobs = recipe.guardrailGlobs ?? [];
  const example = allowedOps.map(opExample).find((e) => e !== null);
  const lines = [
    'You are a deterministic mechanical code-edit worker.',
    'Output ONLY a single JSON object matching the provided schema — no prose, no markdown fences.',
    `You may emit ONLY operations of these kinds: ${allowedOps.join(', ')}.`,
    `You may target ONLY files matching one of these globs: ${guardrailGlobs.join(', ')}.`,
    'Make the SMALLEST mechanical edit that satisfies the task. Never invent files, never change unrelated code, never reformat.',
    'Each op has a "targetPath" (relative to project root) and an "operation" with a "kind" and the fields that kind needs.',
  ];
  if (example) {
    // A concrete few-shot anchor — weak local models reliably copy the SHAPE
    // from an example even when they ignore a bare schema.
    lines.push(`Example of a valid reply (copy the shape, not the values): ${JSON.stringify({ ops: [example] })}`);
  }
  return lines.join('\n');
}

/** Statuses worth re-prompting the worker for (the model can plausibly fix). */
const RETRYABLE_STATUSES: ReadonlySet<DelegateRunStatus> = new Set([
  'generate-failed',
  'guardrail-refused',
  'package-error',
  'conflicts',
  'verify-failed',
]);

/**
 * The testable orchestration core: a bounded GENERATE→VERIFY retry loop. On a
 * retryable failure (parse / guardrail / bad-op / conflict / verification) the
 * worker is re-prompted with the failure injected, up to `recipe.maxAttempts`,
 * then the run escalates. A provider / signing / environment failure is NOT
 * retried. Takes an already-resolved recipe + provider so tests inject a fake.
 */
export async function executeDelegateRun(
  input: IExecuteDelegateRunInput,
): Promise<IExecuteDelegateRunResult> {
  // No local LLM → deterministic no-op (NOT an error).
  if (input.provider === null) {
    return {
      status: 'no-provider',
      recipeId: input.recipe.id,
      message: 'No local LLM reachable — delegate is a no-op. Start Ollama / set LLAMACPP_MODEL_PATH to enable.',
    };
  }
  const maxAttempts = Math.max(1, Math.min(5, input.recipe.maxAttempts ?? 2));
  // In-scope file context for the LOCAL worker (free to the orchestrator).
  const fileContext = gatherRecipeContext(input.projectRoot, input.recipe);
  const baseMessages: IAiMessage[] = [
    { role: AiMessageRole.System, content: systemPrompt(input.recipe) },
    { role: AiMessageRole.User, content: fileContext ? `Task: ${input.task}\n\n${fileContext}` : `Task: ${input.task}` },
  ];
  const feedback: IAiMessage[] = [];
  let last: IExecuteDelegateRunResult = {
    status: 'generate-failed',
    recipeId: input.recipe.id,
    message: 'no attempt ran',
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = { ...(await runOneDelegateAttempt(input, [...baseMessages, ...feedback])), attempts: attempt };
    if (!RETRYABLE_STATUSES.has(last.status) || attempt === maxAttempts) return last;
    // Best-effort LLM diagnosis of the failure (Phase 2). Never blocks the loop:
    // a null return or a throw simply means no extra hint this round.
    let advisory: string | undefined;
    if (input.retryAdvisor) {
      try {
        const adv = await input.retryAdvisor(failureContextOf(last, input.recipe, attempt), attempt);
        advisory = adv ?? undefined;
      } catch {
        advisory = undefined;
      }
    }
    feedback.push(buildRetryFeedback(last, input.recipe, advisory));
  }
  return last;
}

/** Map a delegate run result onto the layer-neutral failure context for grounding. */
function failureContextOf(
  r: IExecuteDelegateRunResult,
  recipe: IDelegateRecipe,
  attempt: number,
): IDelegateFailureContext {
  return {
    status: r.status,
    message: r.message,
    ...(r.conflicts ? { conflicts: r.conflicts } : {}),
    ...(r.verification?.commandsFailed ? { commandsFailed: r.verification.commandsFailed } : {}),
    ...(r.refused ? { refused: r.refused } : {}),
    ...(r.droppedOps ? { droppedOps: r.droppedOps.map((d) => ({ kind: d.kind, targetPath: d.targetPath })) } : {}),
    ...(recipe.guardrailGlobs ? { guardrailGlobs: recipe.guardrailGlobs } : {}),
    ...(recipe.allowedOps ? { allowedOps: recipe.allowedOps } : {}),
    attempt,
  };
}

/**
 * Build the User message that tells the worker why the previous attempt failed.
 * `advisory` (optional) is a corrected-instruction hint from a `retry-analysis`
 * pass (Phase 2, `--assisted-retry`); it augments — never replaces — the
 * deterministic failure detail.
 */
function buildRetryFeedback(r: IExecuteDelegateRunResult, recipe: IDelegateRecipe, advisory?: string): IAiMessage {
  let detail: string;
  if (r.conflicts && r.conflicts.length > 0) {
    detail = `Your previous edit was REFUSED with conflicts: ${r.conflicts.join('; ')}. Fix the target paths / anchors and try again.`;
  } else if (r.status === 'verify-failed') {
    detail = `Your previous edit FAILED verification (${r.verification?.commandsFailed.join(', ') || 'see logs'}) and was reverted. Produce a CORRECT edit.`;
  } else if (r.status === 'guardrail-refused') {
    detail = `You targeted files outside the allowed scope (${(r.refused ?? []).join(', ')}). You may ONLY touch files matching: ${(recipe.guardrailGlobs ?? []).join(', ')}.`;
  } else if (r.status === 'package-error') {
    detail = `${r.message}. You may ONLY use op kinds: ${(recipe.allowedOps ?? []).join(', ')}.`;
  } else {
    detail = `Your previous reply was unusable: ${r.message}.`;
  }
  const advisoryLine = advisory && advisory.trim().length > 0 ? `\nDiagnostic hint: ${advisory.trim()}` : '';
  return {
    role: AiMessageRole.User,
    content: `${detail}${advisoryLine}\nReturn a corrected single JSON object matching the schema — no prose.`,
  };
}

/** One generate→guardrail→package→sign→apply→verify pass. */
async function runOneDelegateAttempt(
  input: IExecuteDelegateRunInput,
  messages: readonly IAiMessage[],
): Promise<IExecuteDelegateRunResult> {
  const { recipe, projectRoot } = input;
  const provider = input.provider!; // non-null: the wrapper handled no-provider

  // Generate (the only stochastic step). The plan secret is NEVER put in the
  // messages — only the task + recipe constraints are.
  const call = await callDelegateWithRetry({
    provider,
    messages,
    ...(recipe.model ? { model: recipe.model } : {}),
    timeoutMs: recipe.maxBudgetMs ?? DEFAULT_MAX_BUDGET_MS,
    reprompt: (bad, error) => [...messages, delegateRepromptMessage(bad, error)],
  });
  if (!call.ok) {
    return {
      status: 'generate-failed',
      recipeId: recipe.id,
      message: `worker failed to produce a valid edit: ${call.error.message}`,
    };
  }
  const edit = call.value.edit;

  // 3. Guardrail globs — refuse any target outside the recipe's blast radius.
  //    The check MUST run on the NORMALIZED path that will actually be written
  //    (a `..` traversal whose `**` the glob swallows would otherwise pass the
  //    fence yet normalize to a file OUTSIDE the fenced dir but still in-root).
  //    So: reject any `..` segment, resolve through the engine's path floor,
  //    and glob-check the resulting relative path — the same string the write
  //    uses via `safeResolveTargetPath` in `evaluateSavedPlanInPlace`.
  const normalizedTargets: string[] = [];
  for (const op of edit.ops) {
    if (containsTraversal(op.targetPath)) {
      return {
        status: 'guardrail-refused',
        recipeId: recipe.id,
        message: `worker target "${op.targetPath}" contains a \`..\` traversal segment`,
        refused: [op.targetPath],
        retried: call.value.retried,
      };
    }
    try {
      normalizedTargets.push(safeResolveTargetPath(op.targetPath, projectRoot).relativePath);
    } catch {
      return {
        status: 'guardrail-refused',
        recipeId: recipe.id,
        message: `worker target "${op.targetPath}" escapes the project root`,
        refused: [op.targetPath],
        retried: call.value.retried,
      };
    }
  }
  const guard = checkGuardrailGlobs(normalizedTargets, recipe.guardrailGlobs ?? []);
  if (!guard.ok) {
    return {
      status: 'guardrail-refused',
      recipeId: recipe.id,
      message: `worker targeted ${guard.refused.length} file(s) outside the recipe's guardrail globs`,
      refused: guard.refused,
      retried: call.value.retried,
    };
  }

  // 4. Package into a synthetic plan (drops disallowed ops, evaluates conflicts).
  const packaged = packageDelegatePlan({
    ops: edit.ops,
    allowedOps: recipe.allowedOps ?? [],
    recipeId: recipe.id,
    projectRoot,
  });
  if (!packaged.ok) {
    return {
      status: 'package-error',
      recipeId: recipe.id,
      message: packaged.error.message,
      retried: call.value.retried,
    };
  }
  if (!packaged.value.ready || !packaged.value.plan) {
    const conflicts = packaged.value.generation.changes
      .filter((c) => String(c.type) === 'conflict')
      .map((c) => `${c.relativePath}: ${c.reason}`);
    return {
      status: 'conflicts',
      recipeId: recipe.id,
      message: `edit evaluated to ${conflicts.length} conflict(s) — refused before any write`,
      conflicts,
      droppedOps: packaged.value.droppedOps,
      retried: call.value.retried,
    };
  }

  // 5. Sign + save the plan.
  const signed = signPlan(packaged.value.plan, input.planSecret ? { secret: input.planSecret } : {});
  if (!signed.ok) {
    return {
      status: 'sign-failed',
      recipeId: recipe.id,
      message: signed.error.message,
      retried: call.value.retried,
    };
  }
  const planPath =
    input.planPath ?? nodePath.join(projectRoot, '.sharkcraft', 'delegate', `${recipe.id}.plan.json`);
  const saved = savePlanToFile(signed.value, planPath);
  if (!saved.ok) {
    return { status: 'apply-failed', recipeId: recipe.id, message: saved.error.message, planPath };
  }

  const baseResult: IExecuteDelegateRunResult = {
    status: 'generated',
    recipeId: recipe.id,
    message: input.apply ? '' : `signed plan written to ${planPath} (not applied; review the diff, then \`shrk apply ${planPath} --verify-signature\` or re-run with --apply)`,
    planPath,
    ops: edit.ops.length,
    droppedOps: packaged.value.droppedOps,
    ...(call.value.usage ? { usage: call.value.usage } : {}),
    retried: call.value.retried,
  };
  if (!input.apply) {
    // Preview: show exactly what the worker WOULD write, so the agent can review
    // before landing it (the plan is signed + saved but unapplied).
    return { ...baseResult, ...(buildPreviewDiff(packaged.value.generation.changes, input.task) ?? {}) };
  }

  // A recipe with no verification has no deterministic gate — refuse to apply an
  // unverified edit (runValidationLoop reports passed:true when no command runs,
  // so this must be caught here). The plan is already signed + saved on disk.
  if ((recipe.verificationIds ?? []).length === 0) {
    return {
      ...baseResult,
      status: 'no-verification',
      message: `recipe "${recipe.id}" declares no verificationIds — refusing to apply an unverified edit (signed plan at ${planPath})`,
    };
  }

  // 6. Apply through the same primitives `shrk apply` uses.
  const verify = verifyPlan(signed.value, input.planSecret ? { secret: input.planSecret } : {});
  if (!verify.ok) {
    return { ...baseResult, status: 'apply-failed', message: `signature verification failed: ${verify.message}` };
  }
  const livePlan = evaluateSavedPlanInPlace(signed.value, projectRoot);
  if (livePlan.hasConflicts) {
    const conflicts = livePlan.changes.filter((c) => String(c.type) === 'conflict').map((c) => `${c.relativePath}: ${c.reason}`);
    return { ...baseResult, status: 'conflicts', message: 'plan diverged at apply time', conflicts };
  }

  // Snapshot originals so a verify failure (or a partial-write failure) can be
  // auto-reverted.
  const snapshots = snapshotChanges(livePlan.changes);
  const write = writeSyntheticPlan(livePlan);
  if (!write.ok) {
    // A mid-write failure can leave earlier files written — revert them.
    revertSnapshots(snapshots);
    return { ...baseResult, status: 'apply-failed', message: write.error.message, reverted: true };
  }
  const written = write.value.written.map((c) => c.relativePath);
  // Compact result hand-back: a compressed unified diff of exactly what changed,
  // so the orchestrator confirms the edit without re-reading the file.
  const diffField = buildCompressedDiff(snapshots, write.value.written, input.task);

  // 7. Deterministic verification gate.
  const validation = await runValidationLoop({
    cwd: projectRoot,
    verificationIds: recipe.verificationIds ?? [],
    allVerifications: false,
    allowPackCommands: false,
    reportDir: input.reportDir ?? nodePath.join(projectRoot, '.sharkcraft', 'delegate', 'reports'),
  });
  if (!validation.passed) {
    revertSnapshots(snapshots);
    return {
      ...baseResult,
      status: 'verify-failed',
      message: `edit verification FAILED (${validation.commandsFailed.join(', ') || 'boundary violations'}) — auto-reverted`,
      written,
      reverted: true,
      verification: { passed: false, commandsFailed: validation.commandsFailed },
      ...(diffField ?? {}),
    };
  }
  return {
    ...baseResult,
    status: 'applied',
    message: `applied + verified (${written.length} file(s))`,
    written,
    verification: { passed: true, commandsFailed: [] },
    ...(diffField ?? {}),
  };
}

/** A compressed unified diff of the written changes (before = snapshot, after = contents). */
function compressedDiffOf(
  pairs: readonly { relativePath: string; before: string; after: string }[],
  task: string,
): { diff: string; diffCcrKey?: string } | null {
  if (pairs.length === 0) return null;
  const bodies = pairs.map(
    (p) => unifiedDiff(p.before, p.after, { relativePath: p.relativePath, maxLines: 60 }).body,
  );
  const compressed = compressDiff(bodies.join('\n'), { query: task });
  return { diff: compressed.compressed, ...(compressed.ccrKey ? { diffCcrKey: compressed.ccrKey } : {}) };
}

/** Diff of the APPLIED edit: before = snapshot, after = written contents. */
function buildCompressedDiff(
  snapshots: readonly ISnapshot[],
  written: readonly { absolutePath: string; relativePath: string; contents: string }[],
  task: string,
): { diff: string; diffCcrKey?: string } | null {
  const before = new Map(snapshots.map((s) => [s.absolutePath, s.original ?? '']));
  return compressedDiffOf(
    written.map((c) => ({ relativePath: c.relativePath, before: before.get(c.absolutePath) ?? '', after: c.contents })),
    task,
  );
}

/**
 * PREVIEW diff for a `delegate run` without `--apply`: before = the file on disk
 * now, after = the proposed contents from the evaluated plan. Lets the agent
 * review exactly what the worker would write before deciding to land it.
 */
function buildPreviewDiff(
  changes: readonly { type: unknown; absolutePath: string; relativePath: string; contents: string }[],
  task: string,
): { diff: string; diffCcrKey?: string } | null {
  const pairs = changes
    .filter((c) => String(c.type) !== 'skip' && String(c.type) !== 'conflict')
    .map((c) => ({
      relativePath: c.relativePath,
      before: existsSync(c.absolutePath) ? readFileSync(c.absolutePath, 'utf8') : '',
      after: c.contents,
    }));
  return compressedDiffOf(pairs, task);
}

interface ISnapshot {
  absolutePath: string;
  /** Original contents, or null when the file did not exist (created). */
  original: string | null;
}

function snapshotChanges(changes: readonly { absolutePath: string; type: string }[]): ISnapshot[] {
  const out: ISnapshot[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    if (c.type === 'skip' || c.type === 'conflict') continue;
    if (seen.has(c.absolutePath)) continue;
    seen.add(c.absolutePath);
    out.push({
      absolutePath: c.absolutePath,
      original: existsSync(c.absolutePath) ? readFileSync(c.absolutePath, 'utf8') : null,
    });
  }
  return out;
}

function revertSnapshots(snapshots: readonly ISnapshot[]): void {
  for (const s of snapshots) {
    try {
      if (s.original === null) {
        if (existsSync(s.absolutePath)) rmSync(s.absolutePath);
      } else {
        writeFileSync(s.absolutePath, s.original, 'utf8');
      }
    } catch {
      /* best-effort revert; report still surfaces verify-failed */
    }
  }
}

// ─── recipe resolution ───────────────────────────────────────────────────────

/**
 * Load the resolved delegate catalog: config recipes + pack-contributed recipes
 * (best-effort) + `recipeOverrides`. Pack discovery failures degrade to
 * config-only — a missing/odd node_modules never blocks a configured recipe.
 */
async function loadResolvedCatalog(
  cwd: string,
): Promise<
  | { ok: true; config: ISharkCraftConfig; projectRoot: string; catalog: readonly IResolvedDelegateRecipe[] }
  | { ok: false; message: string }
> {
  const loaded = await loadProjectConfig(cwd);
  if (!loaded.ok) return { ok: false, message: `could not load config: ${loaded.error.message}` };
  const catalog = await resolveDelegateCatalogForProject(loaded.value.config, loaded.value.projectRoot);
  return { ok: true, config: loaded.value.config, projectRoot: loaded.value.projectRoot, catalog };
}

async function resolveRecipe(
  cwd: string,
  recipeId: string | undefined,
): Promise<{ ok: true; recipe: IResolvedDelegateRecipe; projectRoot: string } | { ok: false; message: string }> {
  const c = await loadResolvedCatalog(cwd);
  if (!c.ok) return { ok: false, message: c.message };
  const delegation = c.config.delegation;
  if (!delegation || delegation.enabled === false) {
    return { ok: false, message: 'delegation is not enabled in sharkcraft.config.ts' };
  }
  if (c.catalog.length === 0) return { ok: false, message: 'no delegate recipes are configured' };
  if (!recipeId) {
    return { ok: false, message: `--recipe <id> is required. Available: ${c.catalog.map((r) => r.id).join(', ')}` };
  }
  const found = c.catalog.find((r) => r.id === recipeId);
  if (!found) {
    return { ok: false, message: `unknown recipe "${recipeId}". Available: ${c.catalog.map((r) => r.id).join(', ')}` };
  }
  // Fold the resolved provider/model onto the recipe (keeping the resolved type
  // so patch consumers see present write-fence arrays) for the run/analyze cores.
  const recipe: IResolvedDelegateRecipe = {
    ...found,
    provider: found.resolvedProvider,
    ...(found.resolvedModel ? { model: found.resolvedModel } : {}),
  };
  return { ok: true, recipe, projectRoot: c.projectRoot };
}

// ─── analysis (read-only, grounded) ──────────────────────────────────────────

export type DelegateAnalyzeStatus = 'no-provider' | 'analyze-failed' | 'analyzed';

export interface IExecuteDelegateAnalyzeInput {
  task: string;
  /** An analysis recipe (mode === 'analysis'); its provider/model are folded. */
  recipe: IResolvedDelegateRecipe;
  /** The deterministic ground truth produced by `runGroundingReport`. */
  facts: IGroundingFacts;
  /** Injectable for tests; `null` means no local LLM is reachable. */
  provider: IAiProvider | null;
  /** Drop non-grounded findings instead of keeping+flagging them. */
  strict?: boolean;
  /**
   * Read-only query executor for the bounded query loop (Phase 3). Injected by
   * the cli from the inspection; absent (or a recipe with no `allowedQueries` /
   * `maxQueryRounds`) ⇒ single-shot analysis. Tests inject a fake.
   */
  queryExecutor?: QueryExecutor;
  /** Human-readable provider label for the report when no model id is returned. */
  providerLabel: string;
  /** Timestamp source (kept out of the core so tests are deterministic). */
  generatedAt: string;
}

/** Human descriptions of the read-only queries shown to the model in the loop. */
export const DELEGATE_QUERY_CATALOG: readonly IQueryDescriptor[] = [
  { name: 'task-risk', description: 'deterministic per-task risk (level, reasons, affected files). args: {task?}' },
  { name: 'coverage', description: 'project-intelligence coverage gaps (weakest categories). args: {}' },
  { name: 'test-impact', description: 'likely + missing tests and risk areas. args: {files?: string[]}' },
  { name: 'graph-callers', description: 'who calls/references a symbol, as path:line. args: {symbol: string}' },
  { name: 'graph-context', description: 'a symbol\'s declaring file + importers/imports (is it wired?). args: {symbol: string}' },
];

/**
 * Build the read-only query executor: maps each `DELEGATE_QUERY_IDS` value to a
 * deterministic inspector function. Every query is read-only — there is no
 * write/apply query. Returns compact text + the entities it surfaced (merged
 * into the analysis ground truth so a finding citing a pulled fact is grounded).
 */
export function buildAnalysisQueryExecutor(inspection: ISharkcraftInspection, task: string): QueryExecutor {
  // The graph index is loaded lazily (only when a graph query is actually asked)
  // and cached across queries in one run. `undefined` = not yet attempted.
  let graphApi: GraphQueryApi | null | undefined;
  const graph = (): GraphQueryApi | null => {
    if (graphApi === undefined) graphApi = loadGraphApiCached(inspection.projectRoot);
    return graphApi;
  };
  return async (name, args) => {
    switch (name) {
      case 'task-risk': {
        const r = await buildTaskRiskReport(typeof args.task === 'string' ? args.task : task, inspection, {});
        const entities = [...r.affectedFiles, ...r.highFanInFiles, ...r.reasons.map((x) => x.code)];
        const content = `risk=${r.riskLevel} score=${r.score}; reasons: ${r.reasons.slice(0, 6).map((x) => x.code).join(', ') || '(none)'}; files: ${r.affectedFiles.slice(0, 8).join(', ') || '(none)'}`;
        return { content, entities };
      }
      case 'coverage': {
        const c = buildCoverageReport(inspection);
        const weak = c.categories.filter((cat) => cat.score < 100).slice(0, 6);
        return {
          content: `overall=${c.overall}%; weakest: ${weak.map((cat) => `${cat.id} ${cat.score}%`).join(', ') || '(all covered)'}`,
          entities: weak.map((cat) => cat.id),
        };
      }
      case 'test-impact': {
        const files = Array.isArray(args.files)
          ? (args.files as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        const t = analyzeTestImpact(inspection, { task, ...(files.length > 0 ? { files } : {}) });
        return {
          content: `existing: ${t.likelyTestFiles.slice(0, 8).join(', ') || '(none)'}; missing: ${t.missingTestFiles.slice(0, 8).join(', ') || '(none)'}; risk: ${t.riskAreas.slice(0, 4).join('; ') || '(none)'}`,
          entities: [...t.missingTestFiles, ...t.likelyTestFiles, ...t.riskAreas],
        };
      }
      case 'graph-callers': {
        const api = graph();
        if (!api) return { content: 'graph index missing — run `shrk graph index`', entities: [] };
        const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
        if (!symbol) return { content: 'graph-callers needs {symbol}', entities: [] };
        const sym = api.findSymbol(symbol, { limit: 1 })[0];
        if (!sym) return { content: `no symbol matched "${symbol}"`, entities: [] };
        const sites = api.callerSitesOf(sym.id).slice(0, 15);
        const lines = sites.map((s) => `${s.node.path ?? s.node.label}${s.line ? `:${s.line}` : ''}`);
        return {
          content: `${symbol}: ${sites.length} caller site(s)\n${lines.join('\n') || '(none)'}`,
          entities: sites.map((s) => s.node.path ?? '').filter((p) => p.length > 0),
        };
      }
      case 'graph-context': {
        const api = graph();
        if (!api) return { content: 'graph index missing — run `shrk graph index`', entities: [] };
        const symbol = typeof args.symbol === 'string' ? args.symbol.trim() : '';
        if (!symbol) return { content: 'graph-context needs {symbol}', entities: [] };
        const sym = api.findSymbol(symbol, { limit: 1 })[0];
        if (!sym) return { content: `no symbol matched "${symbol}"`, entities: [] };
        const file = api.declaringFileOf(sym.id);
        const importers = file ? api.importersOf(file.id).slice(0, 10) : [];
        const imports = file ? api.importsFrom(file.id).slice(0, 10) : [];
        const ent = [sym.path, file?.path, ...importers.map((n) => n.path), ...imports.map((n) => n.path)].filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        );
        return {
          content: `${symbol} declared in ${sym.path ?? file?.path ?? '?'}${sym.line ? `:${sym.line}` : ''}; importers=${importers.length}, imports=${imports.length}`,
          entities: ent,
        };
      }
      default:
        return { content: `unknown query "${name}"`, entities: [] };
    }
  };
}

/** Split `xs` into `g` contiguous, deterministic chunks (last may be smaller). */
function contiguousChunks<T>(xs: readonly T[], g: number): T[][] {
  const groups = Math.max(1, Math.min(g, xs.length));
  const size = Math.ceil(xs.length / groups);
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Dedup raw findings by normalised message, preserving first-seen order. */
function dedupeFindingsByMessage(
  findings: readonly { id?: string; message: string; refs?: readonly string[] }[],
): { id?: string; message: string; refs?: readonly string[] }[] {
  const seen = new Set<string>();
  const out: { id?: string; message: string; refs?: readonly string[] }[] = [];
  for (const f of findings) {
    const key = f.message.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export interface IExecuteDelegateAnalyzeResult {
  status: DelegateAnalyzeStatus;
  recipeId: string;
  report: IDelegateAnalysisReport;
  usage?: { inputTokens?: number; outputTokens?: number };
  retried?: boolean;
}

function analysisSystemPrompt(recipe: IResolvedDelegateRecipe): string {
  return [
    'You are a READ-ONLY code-analysis assistant. You add judgment on top of a deterministic report; you never propose edits.',
    'Output ONLY a single JSON object matching the provided schema — no prose, no markdown fences.',
    'Return a "findings" array. Each finding has a "message" (your judgment) and "refs" (the files / constructs / reason-codes it is about).',
    'CRITICAL: every ref MUST be copied verbatim from the ground truth provided below. Do NOT invent files, symbols, or codes. If you cannot ground a claim in the report, omit it.',
    `Recipe: ${recipe.title ?? recipe.id} — prioritise and explain the risks; flag which ones need human judgment.`,
  ].join('\n');
}

/**
 * The testable analysis core (no I/O beyond the injected provider). Runs the
 * model on the deterministic ground truth, cross-checks its findings, and
 * assembles the advisory report. NEVER writes — analysis mode is read-only.
 * `provider === null` degrades to a deterministic grounding-only report (ok).
 */
export async function executeDelegateAnalyze(
  input: IExecuteDelegateAnalyzeInput,
): Promise<IExecuteDelegateAnalyzeResult> {
  const { recipe, task, facts, provider } = input;

  // No local LLM → deterministic grounding only (NOT an error).
  if (provider === null) {
    const crossCheck = crossCheckFindings([], facts, {});
    return {
      status: 'no-provider',
      recipeId: recipe.id,
      report: buildDelegateAnalysisReport({
        recipeId: recipe.id,
        groundedOn: facts.groundedOn,
        task,
        provider: 'none',
        facts,
        crossCheck,
        modelUnavailable: true,
        generatedAt: input.generatedAt,
      }),
    };
  }

  const messages: IAiMessage[] = [
    { role: AiMessageRole.System, content: analysisSystemPrompt(recipe) },
    {
      role: AiMessageRole.User,
      content: `Task: ${task}\n\nGround truth (do NOT contradict; cite only entities from it in "refs"):\n${facts.summary}`,
    },
  ];
  const model = recipe.model ?? recipe.resolvedModel;

  // Phase 4 — fan-out. Split the grounding entities into deterministic slices,
  // run one focused pass per slice, then merge + dedup. Engine-owned control flow
  // (the model never schedules anything). Takes precedence over the query loop.
  if (recipe.fanOut === true && facts.entities.length >= 2) {
    const g = Math.max(2, Math.min(6, recipe.maxFanOut ?? 3));
    const slices = contiguousChunks(facts.entities, g);
    const merged: { id?: string; message: string; refs?: readonly string[] }[] = [];
    let anySuccess = false;
    for (const slice of slices) {
      const sliceMessages: IAiMessage[] = [
        { role: AiMessageRole.System, content: analysisSystemPrompt(recipe) },
        {
          role: AiMessageRole.User,
          content: `Task: ${task}\n\nFocus your analysis ONLY on these items from the ground truth: ${slice.join(', ')}.\n\nGround truth (cite refs only from it):\n${facts.summary}`,
        },
      ];
      const call = await callDelegateAnalysisWithRetry({
        provider,
        messages: sliceMessages,
        ...(model ? { model } : {}),
        timeoutMs: recipe.maxBudgetMs ?? DEFAULT_MAX_BUDGET_MS,
      });
      if (call.ok) {
        anySuccess = true;
        merged.push(...call.value.analysis.findings);
      }
    }
    if (!anySuccess) {
      return {
        status: 'analyze-failed',
        recipeId: recipe.id,
        report: buildDelegateAnalysisReport({
          recipeId: recipe.id,
          groundedOn: facts.groundedOn,
          task,
          provider: input.providerLabel,
          facts,
          crossCheck: crossCheckFindings([], facts, {}),
          modelUnavailable: true,
          modelNote: 'every fan-out slice failed to produce a valid analysis',
          fanOutSlices: slices.length,
          generatedAt: input.generatedAt,
        }),
      };
    }
    const crossCheck = crossCheckFindings(dedupeFindingsByMessage(merged), facts, { strict: input.strict ?? false });
    return {
      status: 'analyzed',
      recipeId: recipe.id,
      report: buildDelegateAnalysisReport({
        recipeId: recipe.id,
        groundedOn: facts.groundedOn,
        task,
        provider: input.providerLabel,
        facts,
        crossCheck,
        fanOutSlices: slices.length,
        ...(recipe.escalateTo ? { escalateTo: recipe.escalateTo } : {}),
        generatedAt: input.generatedAt,
      }),
    };
  }

  // Phase 3 — bounded read-only query loop. When the recipe opts in
  // (allowedQueries + maxQueryRounds > 0) and a query executor is injected, let
  // the model pull a few read-only facts before answering; entities it surfaces
  // are merged into the ground truth so a finding citing them is grounded.
  if ((recipe.allowedQueries?.length ?? 0) > 0 && (recipe.maxQueryRounds ?? 0) > 0 && input.queryExecutor) {
    const loop = await runBoundedQueryLoop({
      provider,
      messages,
      ...(model ? { model } : {}),
      timeoutMs: recipe.maxBudgetMs ?? DEFAULT_MAX_BUDGET_MS,
      allowedQueries: recipe.allowedQueries ?? [],
      maxQueryRounds: recipe.maxQueryRounds ?? 0,
      ...(recipe.maxBudgetMs ? { budgetMs: recipe.maxBudgetMs } : {}),
      catalog: DELEGATE_QUERY_CATALOG,
      executeQuery: input.queryExecutor,
      finalInstruction:
        'Now output ONLY your findings as a single JSON object matching the schema — no prose, no markdown fences. Cite refs only from the ground truth and the query results.',
      finalResponseFormat: { type: 'json_schema', schema: DELEGATE_ANALYSIS_JSON_SCHEMA, schemaName: 'DelegateAnalysis' },
    });
    if (!loop.ok) {
      return {
        status: 'analyze-failed',
        recipeId: recipe.id,
        report: buildDelegateAnalysisReport({
          recipeId: recipe.id,
          groundedOn: facts.groundedOn,
          task,
          provider: input.providerLabel,
          facts,
          crossCheck: crossCheckFindings([], facts, {}),
          modelUnavailable: true,
          modelNote: `query loop failed: ${loop.error.message}`,
          generatedAt: input.generatedAt,
        }),
      };
    }
    const parsed = parseDelegateAnalysis(loop.value.content);
    if (!parsed.ok) {
      return {
        status: 'analyze-failed',
        recipeId: recipe.id,
        report: buildDelegateAnalysisReport({
          recipeId: recipe.id,
          groundedOn: facts.groundedOn,
          task,
          provider: loop.value.model || input.providerLabel,
          facts,
          crossCheck: crossCheckFindings([], facts, {}),
          modelUnavailable: true,
          modelNote: `model produced an unparseable analysis: ${parsed.error.message}`,
          queriesRun: loop.value.roundsRun,
          generatedAt: input.generatedAt,
        }),
      };
    }
    // Merge query-surfaced entities into the ground truth for the cross-check —
    // a finding citing a fact the model legitimately pulled is grounded.
    const enrichedFacts: IGroundingFacts = { ...facts, entities: [...facts.entities, ...loop.value.gatheredEntities] };
    const crossCheck = crossCheckFindings(parsed.value.findings, enrichedFacts, { strict: input.strict ?? false });
    return {
      status: 'analyzed',
      recipeId: recipe.id,
      report: buildDelegateAnalysisReport({
        recipeId: recipe.id,
        groundedOn: facts.groundedOn,
        task,
        provider: loop.value.model || input.providerLabel,
        facts: enrichedFacts,
        crossCheck,
        ...(parsed.value.note ? { modelNote: parsed.value.note } : {}),
        queriesRun: loop.value.roundsRun,
        ...(recipe.escalateTo ? { escalateTo: recipe.escalateTo } : {}),
        generatedAt: input.generatedAt,
      }),
      ...(loop.value.usage ? { usage: loop.value.usage } : {}),
    };
  }

  const call = await callDelegateAnalysisWithRetry({
    provider,
    messages,
    ...(model ? { model } : {}),
    timeoutMs: recipe.maxBudgetMs ?? DEFAULT_MAX_BUDGET_MS,
    reprompt: (bad, error) => [...messages, delegateAnalysisRepromptMessage(bad, error)],
  });
  if (!call.ok) {
    // The model ran but failed — degrade to grounding-only, note the failure.
    const crossCheck = crossCheckFindings([], facts, {});
    return {
      status: 'analyze-failed',
      recipeId: recipe.id,
      report: buildDelegateAnalysisReport({
        recipeId: recipe.id,
        groundedOn: facts.groundedOn,
        task,
        provider: input.providerLabel,
        facts,
        crossCheck,
        modelUnavailable: true,
        modelNote: `model failed to produce a valid analysis: ${call.error.message}`,
        generatedAt: input.generatedAt,
      }),
    };
  }

  const analysis = call.value.analysis;
  const crossCheck = crossCheckFindings(analysis.findings, facts, { strict: input.strict ?? false });
  return {
    status: 'analyzed',
    recipeId: recipe.id,
    report: buildDelegateAnalysisReport({
      recipeId: recipe.id,
      groundedOn: facts.groundedOn,
      task,
      provider: call.value.model || input.providerLabel,
      facts,
      crossCheck,
      ...(analysis.note ? { modelNote: analysis.note } : {}),
      ...(recipe.escalateTo ? { escalateTo: recipe.escalateTo } : {}),
      generatedAt: input.generatedAt,
    }),
    ...(call.value.usage ? { usage: call.value.usage } : {}),
    retried: call.value.retried,
  };
}

/** The single corrected instruction to feed back: a grounded finding wins. */
export function correctedInstruction(report: IDelegateAnalysisReport): string | null {
  const grounded = report.findings.find((f) => f.grounded);
  if (grounded) return grounded.message;
  if (report.findings.length > 0) return report.findings[0]!.message;
  return report.modelNote ?? null;
}

export interface IRetryAdvisorDeps {
  /** A `mode: 'analysis'`, `groundedOn: 'delegate-failure'` recipe. */
  retryRecipe: IResolvedDelegateRecipe;
  provider: IAiProvider | null;
  providerLabel: string;
  /** The patch recipe being retried (named in the advisor prompt). */
  patchRecipeId: string;
}

/**
 * Build a retry advisor from a `retry-analysis` recipe: it grounds on the failed
 * attempt (`buildDelegateFailureFacts`), runs the analysis model, and returns the
 * single corrected instruction. Read-only — it never writes; a null provider or
 * an empty analysis yields `null` (no enrichment). The corrected instruction is
 * cross-checked against the failure ground truth just like any analysis finding.
 */
export function buildRetryAnalysisAdvisor(
  deps: IRetryAdvisorDeps,
): (failure: IDelegateFailureContext, attempt: number) => Promise<string | null> {
  return async (failure, attempt) => {
    if (deps.provider === null) return null;
    const facts = buildDelegateFailureFacts(failure);
    const result = await executeDelegateAnalyze({
      task: `The delegate patch recipe "${deps.patchRecipeId}" failed on attempt ${attempt} (${failure.status}). Diagnose why and give ONE corrected mechanical instruction, citing the affected files/ops from the ground truth.`,
      recipe: deps.retryRecipe,
      facts,
      provider: deps.provider,
      providerLabel: deps.providerLabel,
      generatedAt: new Date().toISOString(),
    });
    return correctedInstruction(result.report);
  };
}

// ─── CLI surface ─────────────────────────────────────────────────────────────

async function runDelegateAnalyze(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const strict = flagBool(args, 'strict-grounding');
  const task = args.positional.slice(1).join(' ').trim();
  if (!task) {
    process.stderr.write('Usage: shrk delegate analyze "<task>" --recipe <id> [--provider auto] [--strict-grounding] [--json]\n');
    return 2;
  }
  const resolved = await resolveRecipe(cwd, flagString(args, 'recipe'));
  if (!resolved.ok) {
    if (wantJson) process.stdout.write(asJson({ ok: false, error: resolved.message }) + '\n');
    else process.stderr.write(resolved.message + '\n');
    return 1;
  }
  const recipe = resolved.recipe;
  if (recipe.mode !== 'analysis') {
    const msg = `recipe "${recipe.id}" is a patch recipe — use \`shrk delegate run\`. \`analyze\` requires mode: "analysis".`;
    if (wantJson) process.stdout.write(asJson({ ok: false, error: msg }) + '\n');
    else process.stderr.write(msg + '\n');
    return 1;
  }
  if (!recipe.groundedOn) {
    const msg = `analysis recipe "${recipe.id}" has no groundedOn — nothing to ground the model against.`;
    if (wantJson) process.stdout.write(asJson({ ok: false, error: msg }) + '\n');
    else process.stderr.write(msg + '\n');
    return 1;
  }

  const planPath = flagString(args, 'plan');
  const inspection = await inspectSharkcraft({ cwd: resolved.projectRoot });
  const facts = await runGroundingReport(recipe.groundedOn, task, inspection, { ...(planPath ? { planPath } : {}) });
  const providerKind = flagString(args, 'provider') ?? recipe.provider ?? 'auto';
  const { provider } = selectAiProvider(providerKind);
  const result = await executeDelegateAnalyze({
    task,
    recipe,
    facts,
    provider,
    strict,
    queryExecutor: buildAnalysisQueryExecutor(inspection, task),
    providerLabel: provider ? providerKind : 'none',
    generatedAt: new Date().toISOString(),
  });

  // Phase 4 escalation: `--escalate` GENERATES (never applies) the target patch
  // recipe's signed plan through the four fences, from the advisory task. The
  // human reviews + applies — analysis never writes.
  let escalationPlan: IExecuteDelegateRunResult | undefined;
  if (flagBool(args, 'escalate') && result.report.escalation && provider) {
    const patch = await resolveRecipe(cwd, result.report.escalation.recipe);
    if (patch.ok && patch.recipe.mode !== 'analysis') {
      escalationPlan = await executeDelegateRun({
        task: result.report.escalation.task,
        recipe: patch.recipe,
        projectRoot: resolved.projectRoot,
        provider,
        apply: false, // generate-only — the human runs the write
      });
    }
  }

  // --save: persist the advisory report under `.sharkcraft/reports/` (writes-drafts,
  // never source). Markdown for humans + JSON for tooling.
  let savedPath: string | undefined;
  if (flagBool(args, 'save')) {
    const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'analysis';
    const dir = nodePath.join(resolved.projectRoot, '.sharkcraft', 'reports');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    savedPath = nodePath.join(dir, `delegate-analysis-${slug}-${stamp}.md`);
    writeFileSync(savedPath, result.report.markdown, 'utf8');
    writeFileSync(savedPath.replace(/\.md$/, '.json'), asJson(result.report) + '\n', 'utf8');
  }

  const exit = result.status === 'analyze-failed' ? 1 : 0;
  if (wantJson) {
    process.stdout.write(
      asJson({ ok: exit === 0, ...result, ...(escalationPlan ? { escalationPlan } : {}), ...(savedPath ? { savedPath } : {}) }) + '\n',
    );
    return exit;
  }
  const rep = result.report;
  process.stdout.write(header(`Delegate analysis: ${result.recipeId}`));
  process.stdout.write(kv('status', result.status) + '\n');
  process.stdout.write(kv('grounded on', rep.groundedOn) + '\n');
  process.stdout.write(kv('provider', rep.provider) + '\n');
  process.stdout.write(kv('findings', `${rep.findings.length} (grounded ${rep.groundedCount}, unverified ${rep.unverifiedCount})`) + '\n');
  if (savedPath) process.stdout.write(kv('saved', savedPath) + '\n');
  process.stdout.write('\n' + rep.markdown + '\n');
  if (escalationPlan) {
    process.stdout.write(`\n── Escalation (generate-only, review before applying) ──\n`);
    process.stdout.write(kv('patch recipe', escalationPlan.recipeId) + '\n');
    process.stdout.write(kv('status', escalationPlan.status) + '\n');
    if (escalationPlan.planPath) process.stdout.write(kv('signed plan', escalationPlan.planPath) + '\n');
    process.stdout.write(kv('message', escalationPlan.message) + '\n');
  }
  return exit;
}

async function runDelegateRun(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const task = args.positional.slice(1).join(' ').trim();
  if (!task) {
    process.stderr.write('Usage: shrk delegate run "<task>" --recipe <id> [--apply] [--provider auto] [--json]\n');
    return 2;
  }
  const resolved = await resolveRecipe(cwd, flagString(args, 'recipe'));
  if (!resolved.ok) {
    if (wantJson) process.stdout.write(asJson({ ok: false, error: resolved.message }) + '\n');
    else process.stderr.write(resolved.message + '\n');
    return 1;
  }
  const providerKind = flagString(args, 'provider') ?? resolved.recipe.provider ?? 'auto';
  const { provider } = selectAiProvider(providerKind);

  // Opt-in assisted retry: enrich the deterministic retry feedback with an LLM
  // diagnosis from a `retry-analysis` recipe (mode: analysis, groundedOn:
  // delegate-failure). Best-effort — absent a recipe or provider, the loop runs
  // exactly as before.
  let retryAdvisor: IExecuteDelegateRunInput['retryAdvisor'];
  if (flagBool(args, 'assisted-retry') && provider) {
    const cat = await loadResolvedCatalog(cwd);
    const retryRecipe = cat.ok
      ? cat.catalog.find((r) => r.mode === 'analysis' && r.groundedOn === 'delegate-failure' && r.delegatable)
      : undefined;
    if (retryRecipe) {
      retryAdvisor = buildRetryAnalysisAdvisor({
        retryRecipe,
        provider,
        providerLabel: providerKind,
        patchRecipeId: resolved.recipe.id,
      });
    }
  }

  const result = await executeDelegateRun({
    task,
    recipe: resolved.recipe,
    projectRoot: resolved.projectRoot,
    provider,
    apply: flagBool(args, 'apply'),
    ...(retryAdvisor ? { retryAdvisor } : {}),
  });

  if (wantJson) {
    process.stdout.write(asJson({ ok: isOkStatus(result.status), ...result }) + '\n');
    return exitFor(result.status);
  }
  process.stdout.write(header(`Delegate: ${result.recipeId}`));
  process.stdout.write(kv('status', result.status) + '\n');
  if (result.attempts && result.attempts > 1) process.stdout.write(kv('attempts', String(result.attempts)) + '\n');
  process.stdout.write(kv('message', result.message) + '\n');
  if (result.refused && result.refused.length > 0) {
    process.stdout.write('\nRefused (outside guardrail globs):\n');
    for (const f of result.refused) process.stdout.write(`  ✗ ${f}\n`);
  }
  if (result.conflicts && result.conflicts.length > 0) {
    process.stdout.write('\nConflicts:\n');
    for (const c of result.conflicts) process.stdout.write(`  ! ${c}\n`);
  }
  if (result.droppedOps && result.droppedOps.length > 0) {
    process.stdout.write('\nDropped ops (kind not allowed):\n');
    for (const d of result.droppedOps) process.stdout.write(`  - ${d.kind} → ${d.targetPath}\n`);
  }
  if (result.written && result.written.length > 0) {
    process.stdout.write(`\n${result.reverted ? 'Reverted' : 'Wrote'} ${result.written.length} file(s):\n`);
    for (const w of result.written) process.stdout.write(`  ${result.reverted ? '↺' : '✓'} ${w}\n`);
  }
  if (result.diff) {
    process.stdout.write(`\nDiff:\n${result.diff}\n`);
    if (result.diffCcrKey) process.stdout.write(`(compressed — recover with \`shrk expand ${result.diffCcrKey}\`)\n`);
  }
  return exitFor(result.status);
}

async function runDelegateBrief(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const task = args.positional.slice(1).join(' ').trim();
  const resolved = await resolveRecipe(cwd, flagString(args, 'recipe'));
  if (!resolved.ok) {
    if (wantJson) process.stdout.write(asJson({ ok: false, error: resolved.message }) + '\n');
    else process.stderr.write(resolved.message + '\n');
    return 1;
  }
  const r = resolved.recipe;
  const brief = {
    schema: 'sharkcraft.delegate-brief/v1',
    recipeId: r.id,
    title: r.title ?? r.id,
    task: task || null,
    allowedOps: r.allowedOps,
    guardrailGlobs: r.guardrailGlobs,
    verificationIds: r.verificationIds,
    provider: r.provider ?? 'auto',
    model: r.model ?? null,
    next: `shrk delegate run "${task || '<task>'}" --recipe ${r.id} --apply`,
    note: 'Read-only. The worker may only emit the allowed ops, only touch the guardrail globs, and the edit is verified deterministically before it is kept.',
  };
  if (wantJson) {
    process.stdout.write(asJson(brief) + '\n');
    return 0;
  }
  process.stdout.write(header(`Delegate brief: ${brief.title}`));
  process.stdout.write(kv('recipe', r.id) + '\n');
  if (task) process.stdout.write(kv('task', task) + '\n');
  process.stdout.write(kv('allowed ops', r.allowedOps.join(', ')) + '\n');
  process.stdout.write(kv('guardrail globs', r.guardrailGlobs.join(', ')) + '\n');
  process.stdout.write(kv('verification', r.verificationIds.join(', ') || '(none)') + '\n');
  process.stdout.write(kv('provider', `${brief.provider}${r.model ? ` (${r.model})` : ''}`) + '\n');
  process.stdout.write(`\nNext:\n  ${brief.next}\n`);
  return 0;
}

async function runDelegateList(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const c = await loadResolvedCatalog(cwd);
  if (!c.ok) {
    if (wantJson) process.stdout.write(asJson({ ok: false, error: c.message }) + '\n');
    else process.stderr.write(c.message + '\n');
    return 1;
  }
  const catalog = c.catalog;
  if (wantJson) {
    process.stdout.write(asJson({ ok: true, total: catalog.length, recipes: catalog }) + '\n');
    return 0;
  }
  process.stdout.write(header('Delegate recipes'));
  if (catalog.length === 0) {
    process.stdout.write('  (none configured — add a delegation { recipes: [...] } block to sharkcraft.config.ts)\n');
    return 0;
  }
  for (const r of catalog) {
    const src = r.source === 'pack' ? `  [pack: ${r.packageName}]` : '';
    process.stdout.write(`  ${r.delegatable ? '✓' : '✗'} ${r.id}  — ${r.title ?? r.id}  [${r.mode}]${src}\n`);
    if (r.mode === 'analysis') {
      const extras = [
        (r.allowedQueries?.length ?? 0) > 0 ? `queries: ${r.allowedQueries!.join('/')}` : '',
        r.fanOut ? 'fan-out' : '',
        r.escalateTo ? `→ ${r.escalateTo}` : '',
      ].filter((x) => x.length > 0);
      process.stdout.write(`      grounded on: ${r.groundedOn ?? '(unset)'}${extras.length ? `  |  ${extras.join('  |  ')}` : ''}   (read-only)\n`);
      if (!r.delegatable) {
        process.stdout.write(`      ⚠ NOT usable — groundedOn "${r.groundedOn ?? '(unset)'}" is not a known grounding report\n`);
      }
    } else {
      process.stdout.write(`      ops: ${r.allowedOps.join(', ')}  |  globs: ${r.guardrailGlobs.join(', ')}  |  verify: ${r.verificationIds.join(', ') || '(none)'}\n`);
      if (!r.delegatable) {
        process.stdout.write(`      ⚠ NOT delegatable — ${r.unboundVerificationIds.length > 0 ? `unbound verificationIds: ${r.unboundVerificationIds.join(', ')}` : 'no verificationIds declared'}\n`);
      }
    }
  }
  process.stdout.write(`\nRun \`shrk delegate explain <id>\` for the full fence.\n`);
  return 0;
}

async function runDelegateExplain(args: ParsedArgs): Promise<number> {
  const cwd = resolveCwd(args);
  const wantJson = flagBool(args, 'json');
  const recipeId = args.positional[1];
  if (!recipeId) {
    process.stderr.write('Usage: shrk delegate explain <recipeId>\n');
    return 2;
  }
  const c = await loadResolvedCatalog(cwd);
  if (!c.ok) {
    if (wantJson) process.stdout.write(asJson({ ok: false, error: c.message }) + '\n');
    else process.stderr.write(c.message + '\n');
    return 1;
  }
  const r = c.catalog.find((x) => x.id === recipeId);
  if (!r) {
    if (wantJson) process.stdout.write(asJson({ ok: false, error: `unknown recipe "${recipeId}"` }) + '\n');
    else process.stderr.write(`unknown recipe "${recipeId}"\n`);
    return 1;
  }
  const known = new Set((c.config.verificationCommands ?? []).map((v) => v.id));
  const verifications = r.verificationIds.map((id) => ({ id, bound: known.has(id) }));
  if (wantJson) {
    process.stdout.write(asJson({ ok: true, recipe: r, verifications }) + '\n');
    return r.delegatable ? 0 : 1;
  }
  process.stdout.write(header(`Delegate recipe: ${r.id}`));
  process.stdout.write(kv('title', r.title ?? r.id) + '\n');
  process.stdout.write(kv('source', r.source === 'pack' ? `pack: ${r.packageName}` : 'config') + '\n');
  process.stdout.write(kv('mode', r.mode) + '\n');
  if (r.mode === 'analysis') {
    process.stdout.write(
      kv('grounded on', `${r.groundedOn ?? '(unset)'}${r.groundingBound ? '' : ' — NOT a known grounding report'}`) + '\n',
    );
    process.stdout.write(kv('usable', r.delegatable ? 'yes (read-only, grounded)' : 'no — set a known groundedOn first') + '\n');
    process.stdout.write(kv('provider', `${r.resolvedProvider}${r.resolvedModel ? ` (${r.resolvedModel})` : ''}`) + '\n');
    if ((r.allowedQueries?.length ?? 0) > 0) {
      process.stdout.write(kv('query loop', `${r.allowedQueries!.join(', ')}  (max ${r.maxQueryRounds ?? 0} round(s))`) + '\n');
    }
    if (r.fanOut) process.stdout.write(kv('fan-out', `yes (max ${r.maxFanOut ?? 3} slices)`) + '\n');
    if (r.escalateTo) process.stdout.write(kv('escalates to', r.escalateTo) + '\n');
    process.stdout.write(
      '\nAnalysis recipes are READ-ONLY: a local model adds judgment on top of the grounded\n' +
        'deterministic report; findings citing entities absent from it are flagged unverified.\nNo write is ever performed.\n',
    );
    return r.delegatable ? 0 : 1;
  }
  process.stdout.write(kv('delegatable', r.delegatable ? 'yes' : 'no — fix the verification binding first') + '\n');
  process.stdout.write(kv('allowed ops', r.allowedOps.join(', ')) + '\n');
  process.stdout.write(kv('guardrail globs', r.guardrailGlobs.join(', ')) + '\n');
  process.stdout.write(kv('provider', `${r.resolvedProvider}${r.resolvedModel ? ` (${r.resolvedModel})` : ''}`) + '\n');
  process.stdout.write(kv('risk ceiling', r.riskCeiling ?? '(none)') + '\n');
  process.stdout.write(kv('max attempts', String(r.maxAttempts ?? 2)) + '\n');
  process.stdout.write('\nVerification (must pass or the edit is reverted):\n');
  if (verifications.length === 0) {
    process.stdout.write('  ⚠ none declared — the edit would apply UNVERIFIED (refused at apply-time)\n');
  }
  for (const v of verifications) {
    process.stdout.write(`  ${v.bound ? '✓' : '✗'} ${v.id}${v.bound ? '' : '  (NOT in verificationCommands[] — would un-gate the edit)'}\n`);
  }
  process.stdout.write('\nThe worker may emit ONLY the allowed ops and touch ONLY the guardrail globs;\nthe edit is verified deterministically and auto-reverted on failure.\n');
  return 0;
}

function isOkStatus(s: DelegateRunStatus): boolean {
  return s === 'applied' || s === 'generated' || s === 'no-provider';
}
function exitFor(s: DelegateRunStatus): number {
  return isOkStatus(s) ? 0 : 1;
}

export const delegateCommand: ICommandHandler = {
  name: 'delegate',
  description:
    'Hand a mechanical, deterministically-verifiable edit to a local-LLM worker. The engine verifies the result (config verificationCommands) and auto-reverts on failure — a bad generation costs a retry, never a wrong write. Local-only.',
  usage:
    'shrk delegate run "<task>" --recipe <id> [--apply] [--assisted-retry] [--provider auto|ollama|llamacpp] [--json]\n' +
    'shrk delegate analyze "<task>" --recipe <id> [--strict-grounding] [--plan <p>] [--escalate] [--save] [--provider ...] [--json]  — read-only grounded analysis (no write)\n' +
    'shrk delegate brief "<task>" --recipe <id> [--json]\n' +
    'shrk delegate list [--json]                 — recipes + whether each is safely delegatable\n' +
    'shrk delegate explain <id> [--json]         — the full fence for one recipe',
  booleanFlags: new Set(['apply', 'json', 'strict-grounding', 'assisted-retry', 'escalate', 'save']),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'run') return runDelegateRun(args);
    if (sub === 'analyze') return runDelegateAnalyze(args);
    if (sub === 'brief') return runDelegateBrief(args);
    if (sub === 'list') return runDelegateList(args);
    if (sub === 'explain') return runDelegateExplain(args);
    process.stderr.write('Usage: shrk delegate run|analyze|brief|list|explain ...\n');
    return 2;
  },
};
