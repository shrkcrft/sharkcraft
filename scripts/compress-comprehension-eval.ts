/**
 * Agent-comprehension eval (P4.1). Default-on columnar saves WIRE tokens, but
 * might cost the model REASONING tokens or accuracy when it has to mentally
 * re-expand the schema. This harness measures both: it takes homogeneous
 * payloads, encodes each as bare-array / columnar-JSON / CSV / Markdown-KV,
 * then asks a fixed set of extraction questions (with deterministic ground-
 * truth answers) against each encoding and scores accuracy + response tokens.
 *
 *   bun run scripts/compress-comprehension-eval.ts
 *
 * The WIRE-token comparison and the ground-truth answers are fully
 * deterministic and always produced. The accuracy half needs a local model
 * (llamacpp → ollama via `selectAiProvider('auto')`); when none is reachable it
 * degrades gracefully and reports accuracy as "n/a", so the harness still runs
 * offline / in CI. Read-only.
 */
import {
  compactArrayToColumnar,
  columnarToCsv,
  columnarToMarkdownKv,
  type IColumnarTable,
} from '../packages/compress/src/index.ts';
import { selectAiProvider, AiMessageRole } from '../packages/ai/src/index.ts';
import { loadRealTokenizer } from './lib/real-tokens.ts';

interface IQuestion {
  q: string;
  truth: string;
}

interface IFormatRow {
  format: string;
  wireTokens: number;
  wireSavedVsBare: number;
  accuracy: number | null;
  avgResponseTokens: number | null;
}

export interface IComprehensionEval {
  tokenizer: 'real' | 'estimated';
  modelAvailable: boolean;
  rows: IFormatRow[];
}

function buildPayload(): Array<Record<string, unknown>> {
  return Array.from({ length: 40 }, (_, i) => ({
    id: `n${i}`,
    kind: i % 3 === 0 ? 'file' : i % 3 === 1 ? 'symbol' : 'rule',
    score: Math.round((1 - i / 40) * 100) / 100,
    area: ['core', 'api', 'ui'][i % 3],
  }));
}

function buildQuestions(records: Array<Record<string, unknown>>): IQuestion[] {
  const score = (r: Record<string, unknown>): number => r.score as number;
  return [
    {
      q: 'How many records have kind equal to "file"? Answer with just the number.',
      truth: String(records.filter((r) => r.kind === 'file').length),
    },
    {
      q: 'List the ids (comma-separated, no spaces) where score is greater than 0.8, in input order.',
      truth: records.filter((r) => score(r) > 0.8).map((r) => r.id).join(','),
    },
    {
      q: 'What is the score of the record whose id is "n5"? Answer with just the number.',
      truth: String(records[5]!.score),
    },
  ];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.,]/g, '');
}

async function askModel(
  provider: ReturnType<typeof selectAiProvider>['provider'],
  prompt: string,
): Promise<string | null> {
  if (!provider) return null;
  const res = await provider.send({
    messages: [{ role: AiMessageRole.User, content: prompt }],
    maxTokens: 128,
    temperature: 0,
    timeoutMs: 30_000,
  });
  return res.ok ? res.value.content : null;
}

export async function runComprehensionEval(): Promise<IComprehensionEval> {
  const records = buildPayload();
  const table = compactArrayToColumnar(records) as IColumnarTable;
  const questions = buildQuestions(records);

  const encodings: Array<{ format: string; text: string }> = [
    { format: 'bare-array', text: JSON.stringify(records) },
    { format: 'columnar', text: JSON.stringify(table) },
    { format: 'csv', text: columnarToCsv(table) },
    { format: 'mdkv', text: columnarToMarkdownKv(table) },
  ];

  const realTok = await loadRealTokenizer();
  const count = (s: string): number => (realTok ? realTok(s) : Math.ceil(s.length / 4));

  // Probe the provider ONCE. A provider can report `isReady()` (env configured)
  // yet have no daemon/model behind it; without this probe a dead provider would
  // cost 12 timeouts. `modelAvailable` then reflects a real response, not config.
  const { provider } = selectAiProvider('auto');
  const usableProvider =
    provider && (await askModel(provider, 'Reply with the single word: ok')) !== null
      ? provider
      : null;
  const modelAvailable = usableProvider !== null;

  const bareWire = count(encodings[0]!.text);
  const rows: IFormatRow[] = [];
  for (const enc of encodings) {
    const wireTokens = count(enc.text);
    let correct = 0;
    let responseTokenSum = 0;
    let answered = 0;
    for (const { q, truth } of questions) {
      const prompt = `Here is a dataset:\n\n${enc.text}\n\nQuestion: ${q}\nAnswer concisely.`;
      const answer = await askModel(usableProvider, prompt);
      if (answer === null) continue;
      answered += 1;
      responseTokenSum += count(answer);
      if (normalize(answer).includes(normalize(truth))) correct += 1;
    }
    rows.push({
      format: enc.format,
      wireTokens,
      wireSavedVsBare: bareWire - wireTokens,
      accuracy: answered > 0 ? Math.round((correct / answered) * 100) / 100 : null,
      avgResponseTokens: answered > 0 ? Math.round(responseTokenSum / answered) : null,
    });
  }

  return { tokenizer: realTok ? 'real' : 'estimated', modelAvailable, rows };
}

async function main(): Promise<void> {
  const result = await runComprehensionEval();
  // eslint-disable-next-line no-console
  console.log(`\nComprehension eval (${result.tokenizer} tokens)`);
  // eslint-disable-next-line no-console
  console.log(
    result.modelAvailable
      ? 'Local model available — accuracy + response tokens measured.\n'
      : 'No local model reachable — accuracy is n/a; wire-token comparison only.\n',
  );
  // eslint-disable-next-line no-console
  console.log('format        wire   savedVsBare   accuracy   avgRespTokens');
  // eslint-disable-next-line no-console
  console.log('─'.repeat(62));
  for (const r of result.rows) {
    // eslint-disable-next-line no-console
    console.log(
      `${r.format.padEnd(13)} ${String(r.wireTokens).padStart(5)}   ${String(r.wireSavedVsBare).padStart(11)}   ${(r.accuracy === null ? 'n/a' : `${Math.round(r.accuracy * 100)}%`).padStart(8)}   ${String(r.avgResponseTokens ?? 'n/a').padStart(13)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    '\nNet benefit of a format = wire tokens saved − extra reasoning tokens, weighted by accuracy delta.',
  );
  if (!result.modelAvailable) {
    // eslint-disable-next-line no-console
    console.log('Run with a local model (OLLAMA_HOST / LLAMACPP_MODEL_PATH) to fill in accuracy.\n');
  }
}

if (import.meta.main) {
  await main();
}
