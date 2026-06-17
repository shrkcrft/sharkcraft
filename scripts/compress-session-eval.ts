/**
 * Session-level token measurement harness.
 *
 * `compress-validate.ts` proves *per-payload* savings; this proves the
 * *per-session* outcome the whole compression layer exists for: across a fixed,
 * realistic transcript of MCP tool calls a coding agent makes for one task, how
 * many real tokens does columnar `table` mode save versus the explicit-array
 * `json` mode?
 *
 *   bun run scripts/compress-session-eval.ts
 *
 * Deterministic: a fixed transcript, the real repo, a real BPE tokenizer
 * (cl100k_base via `gpt-tokenizer`; falls back to the estimator when absent so
 * the harness still runs offline). Read-only — invokes read-only tool handlers,
 * writes nothing.
 */
import { join } from 'node:path';
import { InMemoryCcrStore } from '../packages/compress/src/index.ts';
import { estimateTokens } from '../packages/compress/src/index.ts';
import { ALL_TOOLS } from '../packages/mcp-server/src/tools/all-tools.ts';
import { serializeToolData } from '../packages/mcp-server/src/server/serialize-tool-data.ts';
import type {
  IToolDefinition,
  IToolResponse,
} from '../packages/mcp-server/src/server/tool-definition.ts';
import { inspectSharkcraft } from '../packages/inspector/src/index.ts';
import { loadRealTokenizer } from './lib/real-tokens.ts';

/** One agent → tool call in the scripted session. */
interface ITranscriptStep {
  /** Registered MCP tool name. */
  readonly tool: string;
  /** Tool input minus the `format` knob (the harness sets that per run). */
  readonly input: Record<string, unknown>;
}

/**
 * A representative "implement a small feature" session: orient → pull the task
 * packet → read the graph → search → list the rules in play. These are the
 * highest-volume read surfaces an agent hits early in a task.
 */
export const DEFAULT_TRANSCRIPT: readonly ITranscriptStep[] = Object.freeze([
  { tool: 'get_start_here', input: {} },
  { tool: 'get_task_packet', input: { task: 'add a new rule for error handling' } },
  { tool: 'get_knowledge_graph', input: {} },
  { tool: 'search_all', input: { query: 'rule', limit: 30 } },
  { tool: 'list_rules', input: {} },
]);

export interface ISessionToolRow {
  readonly tool: string;
  readonly ok: boolean;
  readonly tableOff: number;
  readonly tableOn: number;
  readonly savedPct: number;
}

export interface ISessionEvalResult {
  readonly transcript: string;
  readonly tokenizer: 'real' | 'estimated';
  readonly perTool: readonly ISessionToolRow[];
  readonly totals: { readonly tableOff: number; readonly tableOn: number; readonly savedPct: number };
}

function pct(before: number, after: number): number {
  return before > 0 ? Math.round((1 - after / before) * 100) : 0;
}

/** Serialize a tool response the way the MCP wire would, for counting. */
function payloadOf(res: IToolResponse): string {
  if (res.data !== undefined) return serializeToolData(res.data);
  return res.text ?? '';
}

/**
 * Replay the transcript and total real tokens with table mode off vs on.
 * `cwd` defaults to the repo root; `transcript` defaults to {@link DEFAULT_TRANSCRIPT}.
 */
export async function runSessionEval(opts: {
  cwd: string;
  transcript?: readonly ITranscriptStep[];
  transcriptName?: string;
}): Promise<ISessionEvalResult> {
  const transcript = opts.transcript ?? DEFAULT_TRANSCRIPT;
  const inspection = await inspectSharkcraft({ cwd: opts.cwd });
  const real = await loadRealTokenizer();
  const count = real ?? ((s: string): number => estimateTokens(s));

  const byName = new Map<string, IToolDefinition>(ALL_TOOLS.map((t) => [t.name, t]));
  const perTool: ISessionToolRow[] = [];

  for (const step of transcript) {
    const tool = byName.get(step.tool);
    if (!tool) {
      perTool.push({ tool: step.tool, ok: false, tableOff: 0, tableOn: 0, savedPct: 0 });
      continue;
    }
    // Fresh context per call: read-only handlers, a per-call CCR store.
    const makeCtx = (): unknown => ({
      cwd: opts.cwd,
      inspection,
      allTools: ALL_TOOLS,
      ccrStore: new InMemoryCcrStore(),
    });
    try {
      // table OFF: explicit-array shape (`format:"json"` overrides any env default).
      const off = (await tool.handler(
        { ...step.input, format: 'json' },
        makeCtx() as never,
      )) as IToolResponse;
      // table ON: columnar shape.
      const on = (await tool.handler(
        { ...step.input, format: 'table' },
        makeCtx() as never,
      )) as IToolResponse;
      const ok = off.isError !== true && on.isError !== true;
      const tableOff = count(payloadOf(off));
      const tableOn = count(payloadOf(on));
      perTool.push({ tool: step.tool, ok, tableOff, tableOn, savedPct: pct(tableOff, tableOn) });
    } catch {
      perTool.push({ tool: step.tool, ok: false, tableOff: 0, tableOn: 0, savedPct: 0 });
    }
  }

  // Only successful steps count toward the session total.
  const ok = perTool.filter((r) => r.ok);
  const tableOff = ok.reduce((s, r) => s + r.tableOff, 0);
  const tableOn = ok.reduce((s, r) => s + r.tableOn, 0);
  return {
    transcript: opts.transcriptName ?? 'feature-implementation',
    tokenizer: real ? 'real' : 'estimated',
    perTool,
    totals: { tableOff, tableOn, savedPct: pct(tableOff, tableOn) },
  };
}

async function main(): Promise<void> {
  const result = await runSessionEval({ cwd: process.cwd() });
  const f = (n: number): string => String(n).padStart(8);
  const p = (n: number): string => `${n}%`.padStart(6);
  // eslint-disable-next-line no-console
  console.log(
    `\nSession token eval — transcript "${result.transcript}" (${result.tokenizer} tokens)\n`,
  );
  // eslint-disable-next-line no-console
  console.log('tool                          table-off  table-on   saved   ok');
  // eslint-disable-next-line no-console
  console.log('─'.repeat(66));
  for (const r of result.perTool) {
    // eslint-disable-next-line no-console
    console.log(
      `${r.tool.padEnd(28)} ${f(r.tableOff)}  ${f(r.tableOn)}  ${p(r.savedPct)}   ${r.ok ? 'y' : 'n'}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log('─'.repeat(66));
  // eslint-disable-next-line no-console
  console.log(
    `${'TOTAL'.padEnd(28)} ${f(result.totals.tableOff)}  ${f(result.totals.tableOn)}  ${p(
      result.totals.savedPct,
    )}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `\nTotal tokens table-off → table-on: ${result.totals.tableOff} → ${result.totals.tableOn} (−${result.totals.savedPct}%).\n`,
  );
}

if (import.meta.main) {
  await main();
}
