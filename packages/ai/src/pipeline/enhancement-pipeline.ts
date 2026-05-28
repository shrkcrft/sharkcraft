import { AppErrorImpl, ERROR_CODES, err, ok, type AppError, type Result } from '@shrkcrft/core';
import type { IAiProvider } from '../ai-provider.ts';
import { AiMessageRole, type IAiMessage } from '../ai-request.ts';

/**
 * Identifier for a stage in the multi-pass enhancement pipeline.
 *
 * The default Claude-agent-oriented pipeline runs `draft → critique →
 * refine → polish`. Callers may pass a custom stage list to truncate,
 * extend, or rearrange the flow.
 */
export enum EnhancementStageKind {
  Draft = 'draft',
  Critique = 'critique',
  Refine = 'refine',
  Polish = 'polish',
}

export interface IEnhancementStageInput {
  /** The deterministic ground truth assembled by the engine. */
  originalContext: string;
  /** The original user task / question. */
  task: string;
  /** Output of the previous stage (empty on the first stage). */
  previous: string;
  /** Output of the most recent `critique` stage, when relevant. */
  lastCritique?: string;
}

export interface IEnhancementStage {
  kind: EnhancementStageKind;
  /**
   * Build the messages the LLM should see for this stage. Stages stay
   * pure — the orchestrator owns the provider, retries, and bookkeeping.
   */
  buildMessages(input: IEnhancementStageInput): IAiMessage[];
}

export interface IEnhancementStageResult {
  kind: EnhancementStageKind;
  content: string;
  model: string;
  /** Set when the stage failed and we kept the previous-stage output. */
  degraded?: boolean;
  errorMessage?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface IEnhancementPipelineOptions {
  /** Cap the pipeline depth — useful for cheap models. Default: all stages. */
  maxPasses?: number;
  /** Per-stage `maxTokens`. Default: 4096. */
  maxTokensPerStage?: number;
  /** Per-stage `temperature`. Default: 0.2 (deterministic-ish). */
  temperature?: number;
  /** Override the model selection (forwarded to the provider per call). */
  model?: string;
  /** Optional progress hook — called once per stage. */
  onStage?: (event: { kind: EnhancementStageKind; ok: boolean; pass: number; total: number }) => void;
}

export interface IEnhancementPipelineRun {
  /** Final enriched output. Always defined — falls back to `originalContext` when every stage failed. */
  finalOutput: string;
  /** Per-stage history (ordered). */
  stages: IEnhancementStageResult[];
  /** Aggregated token usage across stages (when reported by the provider). */
  totalUsage: { inputTokens: number; outputTokens: number };
  /**
   * True when the pipeline could not call the LLM at all (no provider
   * passed). The caller is expected to handle this case by returning
   * the deterministic seed unchanged.
   */
  deterministicFallback: boolean;
}

/**
 * Multi-pass refinement pipeline that turns a deterministic brief into
 * a denser, more agent-ready artefact by making the LLM critique and
 * rewrite its own work.
 *
 * Design contract:
 *   - When no provider is supplied, the pipeline returns the
 *     `originalContext` unchanged and flags `deterministicFallback`.
 *     The deterministic engine remains the source of truth.
 *   - When a provider is supplied, every stage call is retried-once on
 *     failure; a permanently-failed stage degrades to the previous
 *     stage's output (the pipeline never throws and never produces
 *     less than the deterministic input).
 *   - Stages compose: a caller can pass a 2-stage `[draft, polish]`
 *     pipeline for fast paths, or extend with custom critique prompts
 *     for project-specific quality bars.
 *
 * Why a pipeline (vs. a single rich prompt): small local models behave
 * dramatically better when asked to "find the gaps in this draft" than
 * when asked to "write the perfect brief in one shot". The critique
 * pass surfaces vague claims and missing evidence; the refine pass
 * fixes them; the polish pass enforces Claude-agent ergonomics
 * (file:line refs, explicit next commands, terse bullets).
 */
export class EnhancementPipeline {
  private readonly stages: ReadonlyArray<IEnhancementStage>;

  constructor(stages: ReadonlyArray<IEnhancementStage>) {
    this.stages = stages;
  }

  async run(
    input: { task: string; originalContext: string },
    provider: IAiProvider | null,
    options: IEnhancementPipelineOptions = {},
  ): Promise<Result<IEnhancementPipelineRun, AppError>> {
    if (!provider) {
      return ok({
        finalOutput: input.originalContext,
        stages: [],
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        deterministicFallback: true,
      });
    }

    const cap = options.maxPasses ?? this.stages.length;
    const plan = this.stages.slice(0, Math.max(1, cap));
    const stagesOut: IEnhancementStageResult[] = [];
    const totalUsage = { inputTokens: 0, outputTokens: 0 };
    let previous = '';
    let lastCritique: string | undefined;
    let lastGood = input.originalContext;

    for (let i = 0; i < plan.length; i += 1) {
      const stage = plan[i]!;
      const messages = stage.buildMessages({
        originalContext: input.originalContext,
        task: input.task,
        previous,
        lastCritique,
      });

      const stageResult = await callOnceWithRetry(provider, {
        messages,
        maxTokens: options.maxTokensPerStage ?? 4096,
        temperature: options.temperature ?? 0.2,
        ...(options.model ? { model: options.model } : {}),
      });

      const onStage = options.onStage;
      if (!stageResult.ok) {
        stagesOut.push({
          kind: stage.kind,
          content: lastGood,
          model: options.model ?? '',
          degraded: true,
          errorMessage: stageResult.error.message,
        });
        if (onStage) onStage({ kind: stage.kind, ok: false, pass: i + 1, total: plan.length });
        // Stage failed: keep last-good output but allow the pipeline to
        // continue. A failed `critique` is recoverable (`refine` just
        // gets no critique). A failed `refine` falls back to the prior
        // draft. A failed `polish` returns the refined draft.
        previous = lastGood;
        continue;
      }

      const content = (stageResult.value.content ?? '').trim();
      const usage = stageResult.value.usage ?? {};
      if (typeof usage.inputTokens === 'number') totalUsage.inputTokens += usage.inputTokens;
      if (typeof usage.outputTokens === 'number') totalUsage.outputTokens += usage.outputTokens;

      stagesOut.push({
        kind: stage.kind,
        content,
        model: stageResult.value.model,
        ...(usage.inputTokens || usage.outputTokens ? { usage } : {}),
      });

      if (stage.kind === EnhancementStageKind.Critique) {
        lastCritique = content;
        // Critique is not a candidate for `finalOutput` — keep the
        // previous draft as the running best.
      } else {
        previous = content;
        lastGood = content;
      }

      if (onStage) onStage({ kind: stage.kind, ok: true, pass: i + 1, total: plan.length });
    }

    return ok({
      finalOutput: lastGood,
      stages: stagesOut,
      totalUsage,
      deterministicFallback: false,
    });
  }
}

/**
 * The default stage set for "make this brief more useful to the Claude
 * agent". Tuned for small local models (Qwen2.5-Coder-3B, Llama-3.1-8B).
 *
 * Each stage's user message is intentionally short and concrete; the
 * heavy lifting (the deterministic seed) lives in the system role
 * and is reused verbatim across stages so the model never loses
 * grounding.
 */
export function buildDefaultEnhancementStages(): IEnhancementStage[] {
  return [
    new DraftStage(),
    new CritiqueStage(),
    new RefineStage(),
    new PolishStage(),
  ];
}

class DraftStage implements IEnhancementStage {
  readonly kind = EnhancementStageKind.Draft;

  buildMessages(input: IEnhancementStageInput): IAiMessage[] {
    return [
      {
        role: AiMessageRole.System,
        content: [
          'You are SharkCraft, a deterministic, local-first code-intelligence engine.',
          'Your job is to write a concise, Claude-agent-ready brief for the supplied task.',
          'Treat the repository context below as the ONLY ground truth. Do NOT invent file paths, symbols, or commands.',
          '',
          '## Repository context',
          input.originalContext.trim(),
        ].join('\n'),
      },
      {
        role: AiMessageRole.User,
        content: [
          `# Task`,
          input.task.trim(),
          '',
          '# Write the draft brief',
          'Sections, in order:',
          '1. **Goal** — one sentence.',
          '2. **Files to read** — bullet list, `path` (no line numbers, just path) with one-line rationale.',
          '3. **Files likely to modify** — bullet list, same format.',
          '4. **Implementation sketch** — 3–6 bullets, imperative.',
          '5. **Risks / unknowns** — bullets; mark each "RISK" or "UNKNOWN".',
          '6. **First commands** — fenced bash, one command per line.',
          '',
          'Be terse. Skip prose. Skip preambles. Skip "I will now…".',
        ].join('\n'),
      },
    ];
  }
}

class CritiqueStage implements IEnhancementStage {
  readonly kind = EnhancementStageKind.Critique;

  buildMessages(input: IEnhancementStageInput): IAiMessage[] {
    return [
      {
        role: AiMessageRole.System,
        content: [
          'You are a code-review style critic for SharkCraft briefs.',
          'Treat the repository context below as the ONLY ground truth.',
          '',
          '## Repository context',
          input.originalContext.trim(),
        ].join('\n'),
      },
      {
        role: AiMessageRole.User,
        content: [
          `# Original task`,
          input.task.trim(),
          '',
          `# Draft brief to critique`,
          input.previous.trim() || '(empty)',
          '',
          '# Critique',
          'Find concrete issues. For each issue: one line, prefixed with one of:',
          '- `GAP:` — something important the brief omits.',
          '- `VAGUE:` — a claim that lacks an exact file path, symbol, or command.',
          '- `WRONG:` — a claim that contradicts the repository context.',
          '- `MISSING-EVIDENCE:` — a claim with no file:line or knowledge-entry id behind it.',
          '',
          'If the draft is already strong, output a single line: `OK`.',
          'Do NOT rewrite the brief. Critique only.',
        ].join('\n'),
      },
    ];
  }
}

class RefineStage implements IEnhancementStage {
  readonly kind = EnhancementStageKind.Refine;

  buildMessages(input: IEnhancementStageInput): IAiMessage[] {
    return [
      {
        role: AiMessageRole.System,
        content: [
          'You are SharkCraft. Rewrite the draft brief to address the critique, while staying strictly grounded in the repository context.',
          '',
          '## Repository context',
          input.originalContext.trim(),
        ].join('\n'),
      },
      {
        role: AiMessageRole.User,
        content: [
          `# Original task`,
          input.task.trim(),
          '',
          `# Draft brief`,
          input.previous.trim() || '(empty)',
          '',
          `# Critique to address`,
          (input.lastCritique ?? 'OK').trim(),
          '',
          '# Rewrite the brief',
          'Same section layout as the draft. Resolve every GAP/VAGUE/WRONG/MISSING-EVIDENCE line by adding an exact file path or removing the claim. Keep it terse.',
        ].join('\n'),
      },
    ];
  }
}

class PolishStage implements IEnhancementStage {
  readonly kind = EnhancementStageKind.Polish;

  buildMessages(input: IEnhancementStageInput): IAiMessage[] {
    return [
      {
        role: AiMessageRole.System,
        content: [
          'You are SharkCraft. Final polish pass — improve readability for an AI coding agent (e.g. Claude Code) that will consume this brief.',
          'Keep the meaning intact. Do not add new facts.',
          '',
          '## Repository context (reference only — do not extend)',
          input.originalContext.trim(),
        ].join('\n'),
      },
      {
        role: AiMessageRole.User,
        content: [
          `# Original task`,
          input.task.trim(),
          '',
          `# Brief to polish`,
          input.previous.trim() || '(empty)',
          '',
          '# Polish pass',
          'Rules:',
          '- Convert any `path` reference to `path:lineNumber` when a line number appears in the context (do not invent line numbers).',
          '- Keep each bullet to one line.',
          '- Promote any imperative verb to the start of the bullet (`Add`, `Wire`, `Replace`, …).',
          '- Surface any RISK / UNKNOWN as a short, scannable bullet.',
          '- Output the brief only — no meta commentary, no "Here is the polished version".',
        ].join('\n'),
      },
    ];
  }
}

async function callOnceWithRetry(
  provider: IAiProvider,
  request: {
    messages: readonly IAiMessage[];
    maxTokens?: number;
    temperature?: number;
    model?: string;
  },
): Promise<Result<{ content: string; model: string; usage?: { inputTokens?: number; outputTokens?: number } }, AppError>> {
  const first = await provider.send(request);
  if (first.ok) {
    return ok({ content: first.value.content, model: first.value.model, usage: first.value.usage });
  }
  // One retry — small local models routinely 500 on the first request
  // after a daemon start. Idempotent reissue is safe.
  const second = await provider.send(request);
  if (second.ok) {
    return ok({ content: second.value.content, model: second.value.model, usage: second.value.usage });
  }
  return err(
    new AppErrorImpl(
      ERROR_CODES.IO_ERROR,
      `Enhancement-pipeline stage failed twice: ${second.error.message}`,
      { cause: second.error },
    ),
  );
}
