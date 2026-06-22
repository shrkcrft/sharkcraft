/**
 * Parse + (lightly) validate the JSON a delegate worker emits, and a one-shot
 * generate→parse→reprompt-once helper. Mirrors the smart-context provider call
 * pattern (`callProviderWithRetry`): a PARSE failure reprompts once; a provider
 * / TIMEOUT error surfaces immediately (the orchestrator owns macro-retries).
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
import { DELEGATE_EDIT_JSON_SCHEMA, type IDelegateRawEdit, type IDelegateRawOp } from './delegate-edit-schema.ts';

function invalid(message: string, cause?: unknown): AppError {
  return new AppErrorImpl(ERROR_CODES.INVALID_INPUT, message, cause !== undefined ? { cause } : undefined);
}

/**
 * Strip a leading/trailing markdown code fence (```json … ```), which weak
 * local models often wrap JSON in despite a json_schema response format.
 */
function stripFences(text: string): string {
  const fence = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
  const m = text.match(fence);
  return m ? m[1]! : text;
}

/** Parse a worker's raw output into a structurally-validated `IDelegateRawEdit`. */
export function parseDelegateEdit(raw: string): Result<IDelegateRawEdit, AppError> {
  const text = stripFences(raw).trim();
  if (text.length === 0) return err(invalid('delegate edit is empty'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return err(invalid('delegate edit is not valid JSON', e));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err(invalid('delegate edit must be a JSON object'));
  }
  const obj = parsed as Record<string, unknown>;
  const opsRaw = obj['ops'];
  if (!Array.isArray(opsRaw)) return err(invalid('delegate edit "ops" must be an array'));
  const ops: IDelegateRawOp[] = [];
  for (let i = 0; i < opsRaw.length; i += 1) {
    const o = opsRaw[i];
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      return err(invalid(`ops[${i}] must be an object`));
    }
    const oo = o as Record<string, unknown>;
    const targetPath = oo['targetPath'];
    if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
      return err(invalid(`ops[${i}].targetPath must be a non-empty string`));
    }
    const operation = oo['operation'];
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      return err(invalid(`ops[${i}].operation must be an object`));
    }
    const kind = (operation as Record<string, unknown>)['kind'];
    if (typeof kind !== 'string' || kind.length === 0) {
      return err(invalid(`ops[${i}].operation.kind must be a non-empty string`));
    }
    ops.push({
      targetPath,
      operation: operation as { kind: string } & Record<string, unknown>,
    });
  }
  const edit: IDelegateRawEdit = { ops };
  if (typeof obj['note'] === 'string') edit.note = obj['note'];
  return ok(edit);
}

export interface IDelegateCallInput {
  provider: IAiProvider;
  messages: readonly IAiMessage[];
  model?: string;
  /** Per-call wall-clock budget; a TIMEOUT surfaces immediately (no retry). */
  timeoutMs?: number;
  maxTokens?: number;
  /**
   * Build the reprompt messages after a PARSE failure. Receives the model's bad
   * output + the parse error. When omitted, a parse failure is returned as-is.
   */
  reprompt?: (badOutput: string, error: AppError) => readonly IAiMessage[];
}

export interface IDelegateCallResult {
  edit: IDelegateRawEdit;
  /** The raw model output that parsed (for telemetry / hand-back). */
  raw: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** True when the first output failed to parse and the reprompt succeeded. */
  retried: boolean;
}

async function sendOnce(
  input: IDelegateCallInput,
  messages: readonly IAiMessage[],
): Promise<Result<{ content: string; model: string; usage?: { inputTokens?: number; outputTokens?: number } }, AppError>> {
  if (input.model) input.provider.configure({ model: input.model });
  const res = await input.provider.send({
    messages,
    ...(input.model ? { model: input.model } : {}),
    ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    responseFormat: { type: 'json_schema', schema: DELEGATE_EDIT_JSON_SCHEMA, schemaName: 'DelegateEdit' },
  });
  if (!res.ok) return res;
  return ok({ content: res.value.content, model: res.value.model, ...(res.value.usage ? { usage: res.value.usage } : {}) });
}

/**
 * Generate a delegate edit, parsing the output. A provider / TIMEOUT error
 * surfaces immediately; a PARSE failure reprompts ONCE (when a reprompt builder
 * is supplied) before giving up.
 */
export async function callDelegateWithRetry(
  input: IDelegateCallInput,
): Promise<Result<IDelegateCallResult, AppError>> {
  const first = await sendOnce(input, input.messages);
  if (!first.ok) return first;
  const parsed = parseDelegateEdit(first.value.content);
  if (parsed.ok) {
    return ok({
      edit: parsed.value,
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
  const reparsed = parseDelegateEdit(second.value.content);
  if (!reparsed.ok) return err(reparsed.error);
  return ok({
    edit: reparsed.value,
    raw: second.value.content,
    model: second.value.model,
    ...(second.value.usage ? { usage: second.value.usage } : {}),
    retried: true,
  });
}

/** Convenience for callers building reprompt messages. */
export function delegateRepromptMessage(badOutput: string, error: AppError): IAiMessage {
  return {
    role: AiMessageRole.User,
    content:
      `Your previous reply could not be parsed: ${error.message}\n` +
      `It must be a single JSON object matching the schema — no prose, no markdown fences.\n` +
      `Previous reply was:\n${badOutput.slice(0, 2000)}`,
  };
}
