/**
 * Parse + (lightly) validate the JSON an `analysis` delegate worker emits, and a
 * one-shot generate→parse→reprompt-once helper. Mirrors `parse-delegate-edit.ts`:
 * a PARSE failure reprompts once; a provider / TIMEOUT error surfaces immediately
 * (the CLI orchestrator owns macro-retries).
 */
import {
  AppErrorImpl,
  ERROR_CODES,
  err,
  ok,
  type AppError,
  type Result,
} from '@shrkcrft/core';
import type { IAiProvider } from '../ai-provider.ts';
import { AiMessageRole, type IAiMessage } from '../ai-request.ts';
import {
  DELEGATE_ANALYSIS_JSON_SCHEMA,
  type IDelegateRawAnalysis,
  type IDelegateRawFinding,
} from './delegate-analysis-schema.ts';

function invalid(message: string, cause?: unknown): AppError {
  return new AppErrorImpl(ERROR_CODES.INVALID_INPUT, message, cause !== undefined ? { cause } : undefined);
}

/** Strip a leading/trailing markdown code fence weak local models often add. */
function stripFences(text: string): string {
  const fence = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
  const m = text.match(fence);
  return m ? m[1]! : text;
}

/** Parse a worker's raw output into a structurally-validated `IDelegateRawAnalysis`. */
export function parseDelegateAnalysis(raw: string): Result<IDelegateRawAnalysis, AppError> {
  const text = stripFences(raw).trim();
  if (text.length === 0) return err(invalid('delegate analysis is empty'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return err(invalid('delegate analysis is not valid JSON', e));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err(invalid('delegate analysis must be a JSON object'));
  }
  const obj = parsed as Record<string, unknown>;
  const findingsRaw = obj['findings'];
  if (!Array.isArray(findingsRaw)) return err(invalid('delegate analysis "findings" must be an array'));
  const findings: IDelegateRawFinding[] = [];
  for (let i = 0; i < findingsRaw.length; i += 1) {
    const f = findingsRaw[i];
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      return err(invalid(`findings[${i}] must be an object`));
    }
    const ff = f as Record<string, unknown>;
    const message = ff['message'];
    if (typeof message !== 'string' || message.trim().length === 0) {
      return err(invalid(`findings[${i}].message must be a non-empty string`));
    }
    const finding: IDelegateRawFinding = { message };
    if (typeof ff['id'] === 'string') finding.id = ff['id'];
    const refs = ff['refs'];
    if (refs !== undefined) {
      if (!Array.isArray(refs) || refs.some((r) => typeof r !== 'string')) {
        return err(invalid(`findings[${i}].refs must be an array of strings`));
      }
      finding.refs = refs as string[];
    }
    findings.push(finding);
  }
  const analysis: IDelegateRawAnalysis = { findings };
  if (typeof obj['note'] === 'string') analysis.note = obj['note'];
  return ok(analysis);
}

export interface IDelegateAnalysisCallInput {
  provider: IAiProvider;
  messages: readonly IAiMessage[];
  model?: string;
  /** Per-call wall-clock budget; a TIMEOUT surfaces immediately (no retry). */
  timeoutMs?: number;
  maxTokens?: number;
  /** Build the reprompt messages after a PARSE failure. */
  reprompt?: (badOutput: string, error: AppError) => readonly IAiMessage[];
}

export interface IDelegateAnalysisCallResult {
  analysis: IDelegateRawAnalysis;
  /** The raw model output that parsed (for telemetry / hand-back). */
  raw: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** True when the first output failed to parse and the reprompt succeeded. */
  retried: boolean;
}

async function sendOnce(
  input: IDelegateAnalysisCallInput,
  messages: readonly IAiMessage[],
): Promise<Result<{ content: string; model: string; usage?: { inputTokens?: number; outputTokens?: number } }, AppError>> {
  if (input.model) input.provider.configure({ model: input.model });
  const res = await input.provider.send({
    messages,
    ...(input.model ? { model: input.model } : {}),
    ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    responseFormat: { type: 'json_schema', schema: DELEGATE_ANALYSIS_JSON_SCHEMA, schemaName: 'DelegateAnalysis' },
  });
  if (!res.ok) return res;
  return ok({ content: res.value.content, model: res.value.model, ...(res.value.usage ? { usage: res.value.usage } : {}) });
}

/**
 * Generate an analysis, parsing the output. A provider / TIMEOUT error surfaces
 * immediately; a PARSE failure reprompts ONCE (when a reprompt builder is
 * supplied) before giving up.
 */
export async function callDelegateAnalysisWithRetry(
  input: IDelegateAnalysisCallInput,
): Promise<Result<IDelegateAnalysisCallResult, AppError>> {
  const first = await sendOnce(input, input.messages);
  if (!first.ok) return first;
  const parsed = parseDelegateAnalysis(first.value.content);
  if (parsed.ok) {
    return ok({
      analysis: parsed.value,
      raw: first.value.content,
      model: first.value.model,
      ...(first.value.usage ? { usage: first.value.usage } : {}),
      retried: false,
    });
  }
  if (!input.reprompt) return err(parsed.error);
  const retryMessages = input.reprompt(first.value.content, parsed.error);
  const second = await sendOnce(input, retryMessages);
  if (!second.ok) return second;
  const reparsed = parseDelegateAnalysis(second.value.content);
  if (!reparsed.ok) return err(reparsed.error);
  return ok({
    analysis: reparsed.value,
    raw: second.value.content,
    model: second.value.model,
    ...(second.value.usage ? { usage: second.value.usage } : {}),
    retried: true,
  });
}

/** Convenience for callers building reprompt messages. */
export function delegateAnalysisRepromptMessage(badOutput: string, error: AppError): IAiMessage {
  return {
    role: AiMessageRole.User,
    content:
      `Your previous reply could not be parsed: ${error.message}\n` +
      `It must be a single JSON object matching the schema — no prose, no markdown fences.\n` +
      `Previous reply was:\n${badOutput.slice(0, 2000)}`,
  };
}
