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
  callDelegateWithRetry,
  delegateRepromptMessage,
  selectAiProvider,
  type IAiMessage,
  type IAiProvider,
} from '@shrkcrft/ai';
import { loadProjectConfig, type IDelegateRecipe, type ISharkCraftConfig } from '@shrkcrft/config';
import { compressCode, compressDiff } from '@shrkcrft/compress';
import { listIndexableFiles } from '@shrkcrft/embeddings';
import {
  checkGuardrailGlobs,
  resolveDelegateCatalogForProject,
  unifiedDiff,
  type IResolvedDelegateRecipe,
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
    candidates = checkGuardrailGlobs(all, recipe.guardrailGlobs).allowed;
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
  const example = recipe.allowedOps.map(opExample).find((e) => e !== null);
  const lines = [
    'You are a deterministic mechanical code-edit worker.',
    'Output ONLY a single JSON object matching the provided schema — no prose, no markdown fences.',
    `You may emit ONLY operations of these kinds: ${recipe.allowedOps.join(', ')}.`,
    `You may target ONLY files matching one of these globs: ${recipe.guardrailGlobs.join(', ')}.`,
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
    feedback.push(buildRetryFeedback(last, input.recipe));
  }
  return last;
}

/** Build the User message that tells the worker why the previous attempt failed. */
function buildRetryFeedback(r: IExecuteDelegateRunResult, recipe: IDelegateRecipe): IAiMessage {
  let detail: string;
  if (r.conflicts && r.conflicts.length > 0) {
    detail = `Your previous edit was REFUSED with conflicts: ${r.conflicts.join('; ')}. Fix the target paths / anchors and try again.`;
  } else if (r.status === 'verify-failed') {
    detail = `Your previous edit FAILED verification (${r.verification?.commandsFailed.join(', ') || 'see logs'}) and was reverted. Produce a CORRECT edit.`;
  } else if (r.status === 'guardrail-refused') {
    detail = `You targeted files outside the allowed scope (${(r.refused ?? []).join(', ')}). You may ONLY touch files matching: ${recipe.guardrailGlobs.join(', ')}.`;
  } else if (r.status === 'package-error') {
    detail = `${r.message}. You may ONLY use op kinds: ${recipe.allowedOps.join(', ')}.`;
  } else {
    detail = `Your previous reply was unusable: ${r.message}.`;
  }
  return {
    role: AiMessageRole.User,
    content: `${detail}\nReturn a corrected single JSON object matching the schema — no prose.`,
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
  const guard = checkGuardrailGlobs(normalizedTargets, recipe.guardrailGlobs);
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
    allowedOps: recipe.allowedOps,
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
  if (recipe.verificationIds.length === 0) {
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
    verificationIds: recipe.verificationIds,
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
): Promise<{ ok: true; recipe: IDelegateRecipe; projectRoot: string } | { ok: false; message: string }> {
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
  // Fold the resolved provider/model onto the recipe for executeDelegateRun.
  const recipe: IDelegateRecipe = {
    ...found,
    provider: found.resolvedProvider,
    ...(found.resolvedModel ? { model: found.resolvedModel } : {}),
  };
  return { ok: true, recipe, projectRoot: c.projectRoot };
}

// ─── CLI surface ─────────────────────────────────────────────────────────────

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
  const result = await executeDelegateRun({
    task,
    recipe: resolved.recipe,
    projectRoot: resolved.projectRoot,
    provider,
    apply: flagBool(args, 'apply'),
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
    process.stdout.write(`  ${r.delegatable ? '✓' : '✗'} ${r.id}  — ${r.title ?? r.id}${src}\n`);
    process.stdout.write(`      ops: ${r.allowedOps.join(', ')}  |  globs: ${r.guardrailGlobs.join(', ')}  |  verify: ${r.verificationIds.join(', ') || '(none)'}\n`);
    if (!r.delegatable) {
      process.stdout.write(`      ⚠ NOT delegatable — ${r.unboundVerificationIds.length > 0 ? `unbound verificationIds: ${r.unboundVerificationIds.join(', ')}` : 'no verificationIds declared'}\n`);
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
    'shrk delegate run "<task>" --recipe <id> [--apply] [--provider auto|ollama|llamacpp] [--json]\n' +
    'shrk delegate brief "<task>" --recipe <id> [--json]\n' +
    'shrk delegate list [--json]                 — recipes + whether each is safely delegatable\n' +
    'shrk delegate explain <id> [--json]         — the full fence for one recipe',
  booleanFlags: new Set(['apply', 'json']),
  async run(args: ParsedArgs): Promise<number> {
    const sub = args.positional[0];
    if (sub === 'run') return runDelegateRun(args);
    if (sub === 'brief') return runDelegateBrief(args);
    if (sub === 'list') return runDelegateList(args);
    if (sub === 'explain') return runDelegateExplain(args);
    process.stderr.write('Usage: shrk delegate run|brief|list|explain ...\n');
    return 2;
  },
};
