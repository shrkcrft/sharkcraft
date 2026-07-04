/**
 * A bounded, read-only QUERY LOOP for `analysis` delegate recipes (Phase 3).
 *
 * Generalises the one-shot `--ai-plan` context-expansion into an iterated loop:
 * each round the model may REQUEST a few read-only engine facts (as JSON, via the
 * schema below — NOT native provider tool-calling, which is brittle with weak
 * local models and would need surgery on the neutral message model); the engine
 * runs only the allow-listed queries, feeds the results back, and repeats until
 * the model is `done`, the round cap is hit, or the wall-clock budget is spent.
 * Then the model produces its final answer with the caller's response format.
 *
 * Layer-clean: the query EXECUTION is injected (`executeQuery`) — this AI-layer
 * runtime never imports the engine. There is deliberately no write/apply/gen/sign
 * query: this is a fact-fetch loop, not an agent.
 */
import { ok, type AppError, type Result } from '@shrkcrft/core';
import type { IAiProvider } from '../ai-provider.ts';
import { AiMessageRole, type IAiMessage, type IAiResponseFormat } from '../ai-request.ts';

/** One read-only query the model may request. */
export interface IQueryDescriptor {
  name: string;
  description?: string;
}

/** The result of running one read-only query. */
export interface IQueryResult {
  /** Compact text the model sees. */
  content: string;
  /** Entities this query surfaced — merged into the analysis ground truth. */
  entities: readonly string[];
}

/** Runs one allow-listed read-only query. Injected by the cli (never in this layer). */
export type QueryExecutor = (name: string, args: Record<string, unknown>) => Promise<IQueryResult>;

export interface IQueryLogEntry {
  name: string;
  args: Record<string, unknown>;
  /** false = refused (not allow-listed) or the executor threw. */
  ok: boolean;
  result: string;
}

export interface IRunQueryLoopInput {
  provider: IAiProvider;
  messages: readonly IAiMessage[];
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** The recipe's read-only query allow-list — the only names the model may call. */
  allowedQueries: readonly string[];
  /** Max planning rounds. Clamped to `[0, 4]`; `0` ⇒ straight to the final answer. */
  maxQueryRounds: number;
  /** Wall-clock budget for the whole loop (best-effort; checked between rounds). */
  budgetMs?: number;
  /** Optional human descriptions of each query, shown to the model. */
  catalog?: readonly IQueryDescriptor[];
  executeQuery: QueryExecutor;
  /** Instruction appended before the final answer turn. */
  finalInstruction: string;
  /** Response format for the FINAL answer (e.g. the analysis findings schema). */
  finalResponseFormat?: IAiResponseFormat;
  /** Cap on queries executed per round (default 4). */
  maxQueriesPerRound?: number;
  /** Injectable clock (default `Date.now`) so budget behaviour is testable. */
  now?: () => number;
}

export interface IRunQueryLoopResult {
  content: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** How many planning rounds actually ran. */
  roundsRun: number;
  /** Audit log of every query requested (executed or refused). */
  queries: readonly IQueryLogEntry[];
  /** Union of entities surfaced by executed queries. */
  gatheredEntities: readonly string[];
  /** True when no query was ever run (rounds 0, or the model never queried). */
  degraded: boolean;
}

/** JSON schema for the per-round query request, with the allow-list as the enum. */
function queryRequestSchema(allowed: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['done'],
    properties: {
      done: { type: 'boolean', description: 'true when you have enough facts to answer' },
      queries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', enum: [...allowed] },
            args: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  };
}

function stripFences(text: string): string {
  const m = text.match(/^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1]! : text;
}

interface IParsedQueryRequest {
  done: boolean;
  queries: { name: string; args: Record<string, unknown> }[];
}

/** Best-effort parse of a query-request turn; returns null if unusable. */
function parseQueryRequest(raw: string): IParsedQueryRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw).trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const done = obj['done'] === true;
  const out: IParsedQueryRequest = { done, queries: [] };
  if (Array.isArray(obj['queries'])) {
    for (const q of obj['queries']) {
      if (!q || typeof q !== 'object') continue;
      const name = (q as Record<string, unknown>)['name'];
      if (typeof name !== 'string' || name.length === 0) continue;
      const args = (q as Record<string, unknown>)['args'];
      out.queries.push({ name, args: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {} });
    }
  }
  return out;
}

function queryInstruction(allowed: readonly string[], catalog: readonly IQueryDescriptor[] | undefined, rounds: number): string {
  const byName = new Map((catalog ?? []).map((c) => [c.name, c.description ?? '']));
  const lines = allowed.map((n) => `  - ${n}${byName.get(n) ? `: ${byName.get(n)}` : ''}`);
  return [
    `You may first pull READ-ONLY facts (up to ${rounds} round(s)) before answering.`,
    'Available queries:',
    ...lines,
    'Respond with JSON: {"done": <bool>, "queries": [{"name": "<query>", "args": {...}}]}.',
    'Request only the facts you need. Set "done": true (and no queries) when ready to answer.',
  ].join('\n');
}

/**
 * Run the bounded query loop, then the final answer turn. A provider error at any
 * point surfaces as `err`. Query fences (allow-list, round cap, budget, per-round
 * cap) are enforced deterministically here — the model can only influence WHICH
 * allow-listed facts are fetched, never whether the fence holds.
 */
export async function runBoundedQueryLoop(
  input: IRunQueryLoopInput,
): Promise<Result<IRunQueryLoopResult, AppError>> {
  const now = input.now ?? Date.now;
  const rounds = Math.max(0, Math.min(4, Math.floor(input.maxQueryRounds)));
  const allowed = new Set(input.allowedQueries);
  const perRound = Math.max(1, input.maxQueriesPerRound ?? 4);
  const conversation: IAiMessage[] = [...input.messages];
  const queries: IQueryLogEntry[] = [];
  const gathered = new Set<string>();
  const startedAt = now();
  let roundsRun = 0;

  if (rounds > 0 && allowed.size > 0) {
    conversation.push({ role: AiMessageRole.User, content: queryInstruction(input.allowedQueries, input.catalog, rounds) });
    const requestSchema = queryRequestSchema(input.allowedQueries);
    for (let round = 0; round < rounds; round += 1) {
      if (input.budgetMs && now() - startedAt > input.budgetMs) break;
      roundsRun += 1;
      const res = await input.provider.send({
        messages: conversation,
        ...(input.model ? { model: input.model } : {}),
        ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        responseFormat: { type: 'json_schema', schema: requestSchema, schemaName: 'QueryRequest' },
      });
      if (!res.ok) return res;
      const parsed = parseQueryRequest(res.value.content);
      if (!parsed || parsed.done || parsed.queries.length === 0) break;
      const resultLines: string[] = [];
      for (const q of parsed.queries.slice(0, perRound)) {
        if (!allowed.has(q.name)) {
          queries.push({ name: q.name, args: q.args, ok: false, result: 'refused: not in the allowed query list' });
          resultLines.push(`- ${q.name}: REFUSED (not permitted)`);
          continue;
        }
        try {
          const out = await input.executeQuery(q.name, q.args);
          queries.push({ name: q.name, args: q.args, ok: true, result: out.content });
          for (const e of out.entities) gathered.add(e);
          resultLines.push(`- ${q.name}(${JSON.stringify(q.args)}):\n${out.content}`);
        } catch (e) {
          queries.push({ name: q.name, args: q.args, ok: false, result: `error: ${(e as Error).message}` });
          resultLines.push(`- ${q.name}: ERROR ${(e as Error).message}`);
        }
      }
      conversation.push({
        role: AiMessageRole.User,
        content: `Query results:\n${resultLines.join('\n')}\n\nRequest more facts (done:false) or set done:true to answer now.`,
      });
    }
  }

  conversation.push({ role: AiMessageRole.User, content: input.finalInstruction });
  const finalRes = await input.provider.send({
    messages: conversation,
    ...(input.model ? { model: input.model } : {}),
    ...(input.maxTokens ? { maxTokens: input.maxTokens } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.finalResponseFormat ? { responseFormat: input.finalResponseFormat } : {}),
  });
  if (!finalRes.ok) return finalRes;
  return ok({
    content: finalRes.value.content,
    model: finalRes.value.model,
    ...(finalRes.value.usage ? { usage: finalRes.value.usage } : {}),
    roundsRun,
    queries,
    gatheredEntities: [...gathered],
    degraded: queries.length === 0,
  });
}
